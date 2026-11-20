import {
  ASK_REFUSAL_SENTENCES,
  ASK_RUN_PARAMS_LABEL,
  ASK_SAVED_PATTERN_INTENT,
  ERROR_CODES,
  SAVED_PATTERN_TEMPLATE_ID,
  ExtensionRefusal,
  askAnswerSchema,
  askContinueRequestSchema,
  askQuestionRequestSchema,
  bindQueryIntent,
  bindTemplateIntent,
  isHeavyResult,
  type AskAnswer,
  type AskEntities,
  type AskFolder,
  type AskPatternListing,
  type AskPatternOffer,
  type AskIntent,
  type AskRefusalCause,
  type AskRunAuditDetail,
  type AskRun,
  type AskRunInput,
  type AssistantThreadTurnWrite,
  type AskRunResult,
  type AuditEvent,
  type AuditResult,
  type ExtensionLogger,
  type ExtensionRefusalFields,
  type ExtensionRequest,
  type ExtensionRoute,
} from '@neburyx/contracts';
import { gateClientOf, type GateClient } from '@neburyx/ee-ai-runtime';
import { createHash, randomUUID } from 'node:crypto';
import { AuditUnavailableError } from '@neburyx/ee-ai-runtime';
import { buildPatternCatalog, type BuiltPatternCatalog } from '../patterns/index.js';
import { summarizeRun } from './run-summary.js';
import { currentRunId, isReplaying, noteRun } from '../assistant/turn-audit.js';
import { summaryOfFileQuery, summaryOfRun } from '../summary/attach.js';
import { canonicalText } from './canonical.js';
import { issueContinueToken, verifyContinueToken } from './continue-token.js';
import type { RunStore } from './run-store.js';

const ASK_QUESTION_URL = '/v1/ask';
const ASK_CONTINUE_URL = '/v1/ask/continue';
const ASK_QUESTION_ACTION = 'ask.question';
const ASK_CONTINUE_ACTION = 'ask.continue';

/** The event of the warning logged when the row of a run could not be written. */
const RUN_NOT_RECORDED_EVENT = 'ask-run-not-recorded';

export interface QuestionRouteOptions {
  readonly folder: () => AskFolder | undefined;
  readonly runs: () => RunStore | undefined;
  readonly logger: () => ExtensionLogger | undefined;
  /** The clock, in milliseconds since the epoch; a test moves it. */
  readonly now?: () => number;
}

type Entities = AskEntities;
export type Capabilities = { readonly askRunner: NonNullable<GateClient['runner']>; readonly signText: NonNullable<ExtensionRequest['signText']>; readonly askSourceReadable: NonNullable<GateClient['sourceReadable']> };

const unsupported = (): ExtensionRefusal => new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });

export function capabilitiesOf(request: ExtensionRequest): Capabilities {
  const { runner, sourceReadable } = gateClientOf(request);
  const { signText } = request;
  if (runner === undefined || signText === undefined || sourceReadable === undefined) throw unsupported();
  return { askRunner: runner, signText, askSourceReadable: sourceReadable };
}

export const refusal = (cause: AskRefusalCause, more: Partial<Extract<AskAnswer, { refused: unknown }>['refused']> = {}): AskAnswer => ({ refused: { cause, sentence: ASK_REFUSAL_SENTENCES[cause], ...more } });

/** A fingerprint of what an intent runs: its kind, template and settings or the hash of its query, and its parameters; a token issued for another definition does not continue this one. */
export const definitionOf = (found: AskIntent): string =>
  createHash('sha256')
    .update(canonicalText(found.kind === 'query' ? ['query', found.query.sha256, found.parameters] : ['template', found.template, found.settings, found.parameters]))
    .digest('hex');

/** The code of a refusal as an audit cause: lower case with dashes. */
const causeOfCode = (code: string): NonNullable<AskRunAuditDetail['cause']> => code.toLowerCase().replace(/_/g, '-') as NonNullable<AskRunAuditDetail['cause']>;

export async function writeEvent(request: ExtensionRequest, action: string, result: AuditResult, sourceId: string | undefined, detail: AskRunAuditDetail): Promise<void> {
  const runId = currentRunId();
  const event: AuditEvent = {
    actorId: request.principalId,
    actorRole: request.principalRole,
    action,
    result,
    ...(sourceId === undefined ? {} : { sourceId }),
    traceId: request.traceId,
    ...(detail.intent === undefined ? {} : { resourceType: 'ask-intent', resourceRef: detail.intent }),
    detail: { askRun: { ...detail, ...(runId === undefined ? {} : { runId }), ...(isReplaying() ? { replay: true as const } : {}) } },
  };
  // the application queues the event and counts and logs its own failures; a failure here does not withhold the answer
  await request.audit.record(event).catch(() => undefined);
}

async function writeRow(runs: RunStore | undefined, logger: ExtensionLogger | undefined, row: Omit<Parameters<RunStore['record']>[0], 'id'>): Promise<void> {
  if (runs === undefined) return;
  try {
    await runs.record({ id: randomUUID(), ...row });
  } catch {
    try {
      logger?.warn({ event: RUN_NOT_RECORDED_EVENT }, 'the row of a run of Ask could not be written');
    } catch {
      // a logger that fails changes nothing
    }
  }
}

/** The saved patterns of one question: the catalog the classifier was shown, its keys, and the offers they stand for. */
interface PatternContext {
  readonly built: BuiltPatternCatalog;
  readonly listing: AskPatternListing;
}

export interface Execution {
  readonly request: ExtensionRequest;
  readonly capabilities: Capabilities;
  readonly options: QuestionRouteOptions;
  readonly sourceId: string;
  readonly mask: boolean;
  readonly intent: string;
  readonly entities: Entities;
  readonly continuing: boolean;
  readonly action: string;
  /** Of a run for a thread: the investigation, which a continue token binds. */
  readonly investigationId?: string;
  /** Of a question: the saved patterns the classifier was shown. */
  readonly patterns?: PatternContext;
  /** Of a continue of a saved pattern: the pattern the route found by its id. */
  readonly offer?: AskPatternOffer;
}

/** What a run needs once an intent is bound: the audit detail, what the runner runs, the parameters the summary reads, the entities as they are answered, the fingerprint of the definition and, for a saved pattern, its label. */
interface Prepared {
  readonly base: AskRunAuditDetail;
  readonly input: AskRunInput;
  readonly params: unknown;
  readonly templateId: AskRunAuditDetail['templateId'];
  readonly definition: string;
  readonly entities: Entities;
  /** The element each parameter of the intent resolved to, found where the intent's settings place the parameter; a value that did not resolve to an element has none. */
  readonly bindings?: AssistantThreadTurnWrite['entities'];
  readonly patternName?: string;
  /** The plain-words label the operator gave the folder intent, when it has one. */
  readonly label?: string;
}

const PATTERN_ID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fingerprint of the pattern a token was issued for: its id and its version, so an edited pattern is not continued by an old token. */
export const patternDefinitionOf = (offer: AskPatternOffer): string => createHash('sha256').update(canonicalText([ASK_SAVED_PATTERN_INTENT, offer.id, offer.version])).digest('hex');

/** The answer for entities that are not the intent's parameters (or do not fit the template): nothing runs, and the event holds the cause. */
async function refusedBinding(run: Execution, base: AskRunAuditDetail, bound: { readonly cause: AskRefusalCause; readonly parameters: readonly string[]; readonly found: readonly string[]; readonly missing: readonly string[]; readonly extra: readonly string[] }): Promise<AskAnswer> {
  await writeEvent(run.request, run.action, 'refused', run.sourceId, { ...base, cause: bound.cause });
  return refusal(bound.cause, { intent: run.intent, parameters: [...bound.parameters], found: [...bound.found], missing: [...bound.missing], extra: [...bound.extra] });
}

const isPrepared = (value: Prepared | AskAnswer): value is Prepared => 'input' in value;

/** Binds the entities of an intent of the folder: a query or a template. */
async function prepareFolderIntent(run: Execution): Promise<Prepared | AskAnswer> {
  const { request, options, sourceId, intent: name, entities } = run;
  const found = options.folder()?.intent(sourceId, name);
  if (found === undefined) {
    await writeEvent(request, run.action, 'refused', sourceId, { kind: 'template', outcome: 'refused', cause: run.continuing ? 'continue-invalid' : 'unknown-intent' });
    if (run.continuing) throw new ExtensionRefusal({ code: 'INVALID_REQUEST', reason: 'continue-invalid' });
    return refusal('unknown-intent');
  }
  const base: AskRunAuditDetail = { intent: name, kind: found.kind === 'query' ? 'query' : 'template', outcome: 'refused', ...(found.kind === 'query' ? { querySha256: found.query.sha256 } : {}) };
  if (found.kind === 'query') {
    const bound = bindQueryIntent(found, entities);
    if (!bound.ok) return refusedBinding(run, base, bound);
    return { base, input: { fileQuery: { intent: name, values: bound.values } }, params: bound.values, templateId: undefined, definition: definitionOf(found), entities, ...(found.label === undefined ? {} : { label: found.label }) };
  }
  const bound = bindTemplateIntent({ template: found.template as Parameters<typeof bindTemplateIntent>[0]['template'], parameters: found.parameters, settings: found.settings }, entities);
  if (!bound.ok) return refusedBinding(run, base, bound);
  return { base, input: { templateId: bound.template, params: bound.params }, params: bound.params, templateId: bound.template, definition: definitionOf(found), entities, ...(found.label === undefined ? {} : { label: found.label }), bindings: bindingsOf(sourceId, found.settings, bound.params) };
}

/** Binds the entities of the intent `saved-pattern`: the key of a pattern of this question's catalog (or, on a continue, the id of the pattern the route found), and the anchor when the pattern asks for one. */
async function prepareSavedPattern(run: Execution): Promise<Prepared | AskAnswer> {
  const { request, entities } = run;
  const unresolved: AskRunAuditDetail = { intent: ASK_SAVED_PATTERN_INTENT, kind: 'template', outcome: 'refused', templateId: SAVED_PATTERN_TEMPLATE_ID };
  let offer = run.offer;
  if (offer === undefined) {
    const { patterns } = run;
    if (patterns === undefined) {
      await writeEvent(request, run.action, 'refused', run.sourceId, { intent: ASK_SAVED_PATTERN_INTENT, kind: 'template', outcome: 'refused', cause: 'unknown-intent' });
      return refusal('unknown-intent');
    }
    const key = entities['pattern'];
    if (key === undefined) {
      const found = Object.keys(entities);
      return refusedBinding(run, unresolved, { cause: 'missing-inputs', parameters: ['pattern'], found, missing: ['pattern'], extra: found });
    }
    const target = patterns.built.targets.get(key);
    offer = target === undefined ? undefined : patterns.listing.offers.find((candidate) => candidate.id === target.id && candidate.version === target.version);
    if (offer === undefined) {
      await writeEvent(request, run.action, 'refused', run.sourceId, { ...unresolved, cause: 'nothing-found' });
      return refusal('nothing-found', { intent: run.intent });
    }
  }
  const asked = offer.projection.startingEntity === 'asked';
  const parameters = asked ? ['pattern', 'anchor'] : ['pattern'];
  const found = Object.keys(entities);
  const missing = parameters.filter((name) => !found.includes(name));
  const extra = found.filter((name) => !parameters.includes(name));
  const base: AskRunAuditDetail = { ...unresolved, patternId: offer.id, patternVersion: offer.version };
  if (missing.length > 0 || extra.length > 0) return refusedBinding(run, base, { cause: missing.length > 0 ? 'missing-inputs' : 'extra-inputs', parameters, found, missing, extra });
  const anchor = entities['anchor'];
  const params = { patternId: offer.id, patternVersion: offer.version, ...(asked && anchor !== undefined ? { ref: { entityType: offer.projection.anchorType, stableId: anchor } } : {}) };
  return {
    base,
    input: { templateId: SAVED_PATTERN_TEMPLATE_ID, params },
    params,
    templateId: SAVED_PATTERN_TEMPLATE_ID,
    definition: patternDefinitionOf(offer),
    entities: { pattern: offer.id, ...(anchor === undefined ? {} : { anchor }) },
    bindings: asked && anchor !== undefined ? [{ role: 'anchor', ref: { sourceId: run.sourceId, entityType: offer.projection.anchorType, stableId: anchor } }] : [],
    patternName: offer.name,
  };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The elements the parameters of a template intent resolved to: the settings of the intent place a parameter as `{ entityType, stableId: '$role' }`, and the bound parameters hold the entity of the same place, so each
 * role gets the element of its own place (both ends of a path, and equal values of two roles, each keep their own).
 */
function bindingsOf(sourceId: string, settings: unknown, params: unknown): AssistantThreadTurnWrite['entities'] {
  const found: AssistantThreadTurnWrite['entities'] = [];
  const walk = (setting: unknown, bound: unknown): void => {
    if (Array.isArray(setting) && Array.isArray(bound)) {
      setting.forEach((entry, index) => walk(entry, bound[index]));
      return;
    }
    if (!isRecord(setting) || !isRecord(bound)) return;
    const placed = setting['stableId'];
    const entityType = bound['entityType'];
    const stableId = bound['stableId'];
    if (typeof placed === 'string' && placed.startsWith('$') && typeof entityType === 'string' && typeof stableId === 'string') {
      found.push({ role: placed.slice(1), ref: { sourceId, entityType, stableId } });
      return;
    }
    for (const name of Object.keys(setting)) walk(setting[name], bound[name]);
  };
  walk(settings, params);
  return found;
}

/** Runs one intent of a source that the caller may read: binds the entities, runs it through the gate, and writes the event, the row and the summary in that order. */
export async function execute(run: Execution): Promise<AskAnswer> {
  const { request, capabilities, options, sourceId, intent: name } = run;
  const logger = options.logger();
  const prepared = run.intent === ASK_SAVED_PATTERN_INTENT ? await prepareSavedPattern(run) : await prepareFolderIntent(run);
  if (!isPrepared(prepared)) return prepared;
  const { base, input, params, templateId, entities } = prepared;
  const paramsHash = capabilities.signText(canonicalText([ASK_RUN_PARAMS_LABEL, 1, name, entities]));
  const started = (options.now ?? Date.now)();
  noteRun({ intent: name, ...(templateId === undefined ? {} : { templateId }), paramsHash, entities: prepared.bindings ?? [] });
  let outcome: AskRun;
  try {
    outcome = await capabilities.askRunner({ sourceId, mask: run.mask }).run(input, run.continuing ? { continue: true } : undefined);
  } catch (error) {
    // a failure that is not one of the gate's refusals (a source failure, a timeout, the refusal of a read transaction): the run is audited as failed with the code of the error, never a value, and the error goes on as it was
    await failedRun(run, error, { ...base, ...(templateId === undefined ? {} : { templateId }), paramsHash }, Math.max(0, (options.now ?? Date.now)() - started), logger);
    throw error;
  }
  const elapsedMs = Math.max(0, (options.now ?? Date.now)() - started);
  if (outcome.status === 'refused') return refusedRun(run, outcome.refusal, { ...base, ...(templateId === undefined ? {} : { templateId }), paramsHash }, elapsedMs, logger);
  const result: AskRunResult = outcome.result;
  // a file query that returned nothing answers as a template run that finds nothing does, and is not recorded as a run
  if (result.templateId === 'file-query' && result.result.nodes.length === 0 && result.result.edges.length === 0) {
    await writeEvent(request, run.action, 'refused', sourceId, { ...base, ...(templateId === undefined ? {} : { templateId }), paramsHash, outcome: 'refused', cause: 'nothing-found', rowCount: 0 });
    return refusal('nothing-found', { intent: name });
  }
  // a path search that found no path between two entities that exist has nothing to cite: it answers as a query that returns nothing does
  if (result.templateId === 'shortest-paths' && result.result.status === 'ok' && result.result.paths.length === 0) {
    await writeEvent(request, run.action, 'refused', sourceId, { ...base, ...(templateId === undefined ? {} : { templateId }), paramsHash, outcome: 'refused', cause: 'nothing-found', rowCount: 0 });
    return refusal('nothing-found', { intent: name });
  }
  const heavy = isHeavyResult(result);
  const { rowCount, partial } = summarizeRun(result);
  const answerOutcome = heavy || partial ? 'partial' : 'complete';
  await writeEvent(request, run.action, answerOutcome === 'partial' ? 'partial' : 'success', sourceId, { ...base, outcome: answerOutcome, ...(templateId === undefined ? {} : { templateId }), paramsHash, rowCount });
  if (!heavy) await writeRow(options.runs(), logger, { actorId: request.principalId, intent: name, outcome: answerOutcome, rowCount, elapsedMs });
  const summary = heavy ? undefined : result.templateId === 'file-query' ? summaryOfFileQuery(result.result, sourceId, logger) : summaryOfRun(result, { sourceId, params }, logger);
  const continueToken = heavy ? issueContinueToken(capabilities.signText, { principalId: request.principalId, sourceId, intent: name, definition: prepared.definition, entities, mask: run.mask, ...(run.investigationId === undefined ? {} : { investigationId: run.investigationId }) }, (options.now ?? Date.now)()) : undefined;
  return { answered: { intent: name, entities, outcome: answerOutcome, result, ...(summary === undefined ? {} : { summary }), ...(continueToken === undefined ? {} : { continueToken }), ...(prepared.patternName === undefined ? {} : { patternName: prepared.patternName }), ...(prepared.label === undefined ? {} : { label: prepared.label }) } };
}

/** The code of an error as an audit cause: the lower-case form of its error code when it has one the product knows, and an internal error otherwise. */
function causeOfError(error: unknown): NonNullable<AskRunAuditDetail['cause']> {
  const code: unknown = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code) ? causeOfCode(code) : 'internal-error';
}

/** A run that failed without being refused: one event of the question with the outcome `failed` and its cause, and the row of the run as failed. An event that cannot be written fails the call as the audit's own failure. */
async function failedRun(run: Execution, error: unknown, detail: AskRunAuditDetail, elapsedMs: number, logger: ExtensionLogger | undefined): Promise<void> {
  await writeEvent(run.request, run.action, 'failed', run.sourceId, { ...detail, outcome: 'failed', cause: causeOfError(error) });
  await writeRow(run.options.runs(), logger, { actorId: run.request.principalId, intent: run.intent, outcome: 'failed', rowCount: 0, elapsedMs });
}

/** A run the gate refused: an anchor that is not there is an answer (nothing found); any other refusal is a failed run, recorded and audited, and then given back as the gate gives it. */
async function refusedRun(run: Execution, fields: ExtensionRefusalFields, detail: AskRunAuditDetail, elapsedMs: number, logger: ExtensionLogger | undefined): Promise<AskAnswer> {
  if (fields.code === 'NOT_FOUND') {
    await writeEvent(run.request, run.action, 'refused', run.sourceId, { ...detail, outcome: 'refused', cause: 'nothing-found' });
    return refusal('nothing-found', { intent: run.intent });
  }
  await writeEvent(run.request, run.action, 'failed', run.sourceId, { ...detail, outcome: 'failed', cause: causeOfCode(fields.code) });
  await writeRow(run.options.runs(), logger, { actorId: run.request.principalId, intent: run.intent, outcome: 'failed', rowCount: 0, elapsedMs });
  throw new ExtensionRefusal(fields);
}

export function createAskQuestionRoute(options: QuestionRouteOptions): ExtensionRoute {
  return {
    method: 'POST',
    url: ASK_QUESTION_URL,
    permission: 'principal',
    requestSchema: askQuestionRequestSchema,
    responseSchema: askAnswerSchema,
    async handler(request) {
      const capabilities = capabilitiesOf(request);
      const body = askQuestionRequestSchema.parse(request.body);
      const mask = body.mask === true;
      await capabilities.askSourceReadable(body.sourceId);
      if (options.folder()?.source(body.sourceId) === undefined) {
        await writeEvent(request, ASK_QUESTION_ACTION, 'refused', body.sourceId, { kind: 'template', outcome: 'refused', cause: 'no-ask-for-source' });
        return refusal('no-ask-for-source');
      }
      // the caller's own saved patterns, listed only for a source that has Ask; the classifier is shown their catalog and the route keeps the keys
      const { patterns } = gateClientOf(request);
      const listing = patterns === undefined ? undefined : await patterns(body.sourceId);
      const built = listing === undefined ? undefined : buildPatternCatalog(listing);
      // the application's classifier: the one it was given, or the extension's own, or the Community default that says it is not available
      const { askClassifier: classifier } = request;
      let classified;
      try {
        classified = await classifier.classify({ sourceId: body.sourceId, question: body.question, actorId: request.principalId, actorRole: request.principalRole, traceId: request.traceId, ...(built === undefined ? {} : { patternCatalog: built.catalog.text }) }, request.signal);
      } catch (error) {
        // the model returned a prompt other than the one sent, so nothing of the call is kept: the one case in which a classification is withheld
        if (error instanceof AuditUnavailableError) throw new ExtensionRefusal({ code: 'AUDIT_UNAVAILABLE' });
        throw error;
      }
      if (!classified.ok) {
        if (classified.cause === 'unavailable') throw unsupported();
        await writeEvent(request, ASK_QUESTION_ACTION, 'refused', body.sourceId, { kind: 'template', outcome: 'refused', cause: classified.cause });
        return refusal(classified.cause);
      }
      return execute({ request, capabilities, options, sourceId: body.sourceId, mask, intent: classified.intent, entities: classified.entities, continuing: false, action: ASK_QUESTION_ACTION, ...(built === undefined || listing === undefined ? {} : { patterns: { built, listing } }) });
    },
  };
}

/** The saved pattern a continue names by its id, as the application offers it to the caller; anything that is not that, a refusal of the application included, is undefined. */
export async function patternOf(find: NonNullable<GateClient['findPattern']>, sourceId: string, entities: Entities): Promise<AskPatternOffer | undefined> {
  const id = entities['pattern'];
  if (id === undefined || !PATTERN_ID_TEXT.test(id)) return undefined;
  try {
    return await find(sourceId, id);
  } catch {
    return undefined;
  }
}

export function createAskContinueRoute(options: QuestionRouteOptions): ExtensionRoute {
  return {
    method: 'POST',
    url: ASK_CONTINUE_URL,
    permission: 'principal',
    requestSchema: askContinueRequestSchema,
    responseSchema: askAnswerSchema,
    async handler(request) {
      const capabilities = capabilitiesOf(request);
      const body = askContinueRequestSchema.parse(request.body);
      const mask = body.mask === true;
      // what the token was issued for: the intent of the folder, or the saved pattern the application finds by its id (a pattern that is not one of the caller's, or an id that is not one, is as absent as an intent that is gone)
      let offer: AskPatternOffer | undefined;
      let definition: string | undefined;
      if (body.intent === ASK_SAVED_PATTERN_INTENT) {
        const { findPattern } = gateClientOf(request);
        if (findPattern === undefined) throw unsupported();
        offer = await patternOf(findPattern, body.sourceId, body.entities);
        definition = offer === undefined ? undefined : patternDefinitionOf(offer);
      } else {
        const found = options.folder()?.intent(body.sourceId, body.intent);
        definition = found === undefined ? undefined : definitionOf(found);
      }
      const binding = { principalId: request.principalId, sourceId: body.sourceId, intent: body.intent, definition: definition ?? '', entities: body.entities, mask };
      if (definition === undefined || !verifyContinueToken(capabilities.signText, body.continueToken, binding, (options.now ?? Date.now)())) {
        // the source is not named: nothing here says it is configured, and the body's text is the caller's
        await writeEvent(request, ASK_CONTINUE_ACTION, 'refused', undefined, { kind: 'template', outcome: 'refused', cause: 'continue-invalid' });
        throw new ExtensionRefusal({ code: 'INVALID_REQUEST', reason: 'continue-invalid' });
      }
      await capabilities.askSourceReadable(body.sourceId);
      return execute({ request, capabilities, options, sourceId: body.sourceId, mask, intent: body.intent, entities: body.entities, continuing: true, action: ASK_CONTINUE_ACTION, ...(offer === undefined ? {} : { offer }) });
    },
  };
}
