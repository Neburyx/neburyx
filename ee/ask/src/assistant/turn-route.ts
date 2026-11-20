import {
  ASK_SAVED_PATTERN_INTENT,
  ASSISTANT_CHOICE_INVALID_SENTENCE,
  ASSISTANT_CONTINUE_INVALID_SENTENCE,
  ASSISTANT_LIMIT_SENTENCES,
  ASSISTANT_NOT_ANSWERED_SENTENCE,
  ASSISTANT_REFUSAL_SENTENCES,
  ASSISTANT_SUMMARY_INVALID_SENTENCE,
  ASSISTANT_TOO_LARGE_SENTENCE,
  ExtensionRefusal,
  assistantTurnAnswerSchema,
  assistantTurnRequestSchema,
  readViewKeys,
  type AskAnswer,
  type AskEntities,
  type AskFolder,
  type AskPatternOffer,
  type AssistantChoice,
  type AssistantFailureKind,
  type AssistantLimit,
  type AssistantRead,
  type AssistantRouterReply,
  type AssistantTurnAnswer,
  type AssistantTurnRequest,
  type ElementRefs,
  type ExtensionLogger,
  type ExtensionRequest,
  type ExtensionRoute,
  type RecordQueue,
} from '@neburyx/contracts';
import { withTemplateTools } from './tool-templates.js';
import { AuditUnavailableError, gateClientOf, type FailureCode } from '@neburyx/ee-ai-runtime';
import { buildPatternCatalog } from '../patterns/index.js';
import { coverageOf } from './coverage.js';
import { readOfAnswer } from './reads.js';
import { capabilitiesOf, definitionOf, execute, patternDefinitionOf, patternOf, refusal, writeEvent, type Execution } from '../questions/question-routes.js';
import { canonicalText } from '../questions/canonical.js';
import { verifyContinueToken } from '../questions/continue-token.js';
import type { RouterInput, RouterOutcome } from './router.js';
import type { AssistantRunStore } from './run-store.js';
import { issueChoiceToken, verifyChoiceToken } from './choice-token.js';
import { candidatesFor, candidatesOfReply, clarificationAnswer, roleEntityType, type Candidate } from './clarification.js';
import { followUpsOf, type FollowUp } from './follow-ups.js';
import { buildContext, canonical, withView, type TurnContext } from './context.js';
import { ATTACHED_SUMMARY_LINE, openAttachment, type SummaryAttachment } from './summary-attachment.js';
import type { TokenKeys } from '../case-summary/token-keys.js';
import type { AssistantThreadStore } from './thread-store.js';
import type { AssistantSettings } from './settings.js';
import { noteResumes, noteStep, noteTurn, noteTurnStarted, readTurnContext, withTurnAudit } from './turn-audit.js';
import { auditConfirmation, openDecision, waitingAnswer, type WaitContext } from './confirmation.js';
import type { AssistantPendingStore } from './pending-store.js';
import { countWords } from './words.js';
import type { ViewInput, ViewOutcome, ViewProgress } from './view-answer.js';
import { toolRegistryOf, type LoopInput, type LoopOutcome } from './tool-loop.js';

const TURNS_URL = '/v1/assistant/turns';
const ASK_ACTION = 'assistant.ask';
const CONTINUE_ACTION = 'assistant.continue';
const MILLISECONDS_A_SECOND = 1000;

export interface TurnRouteOptions {
  readonly maxMessageWords: () => number | undefined;
  readonly router: () => ((input: RouterInput, signal: AbortSignal) => Promise<RouterOutcome>) | undefined;
  readonly folder: () => AskFolder | undefined;
  /** The time of a whole turn; the router and the answer are stopped when it is spent. */
  readonly totalTimeoutMs?: () => number | undefined;
  /** Only a test sets this, to end a turn by hand instead of by the clock. */
  readonly turnDeadline?: (totalMs: number) => AbortSignal;
  /** Answers from the elements in view; without it the view route gives the fixed sentence. */
  readonly viewAnswer?: () => ((input: ViewInput) => Promise<ViewOutcome>) | undefined;
  /** Whether the view call may answer with a tool request, which goes on in the loop from the view's reading; absent or false, the view call has its two reply forms. */
  readonly viewTools?: () => boolean;
  /** The loop after an `ask` run: the model may ask for another registered read. Without it, an `ask` turn is its one read, as before the loop. */
  readonly toolLoop?: () => ((input: LoopInput) => Promise<LoopOutcome | undefined>) | undefined;
  readonly logger: () => ExtensionLogger | undefined;
  /** The store of the records of the turns' model calls; absent, nothing is recorded. */
  readonly runs?: () => AssistantRunStore | undefined;
  readonly runSettings?: () => AssistantSettings | undefined;
  /** The store of the threads and the queue of the records its writes go through; absent, no thread is kept. */
  readonly threads?: () => AssistantThreadStore | undefined;
  readonly records?: () => RecordQueue | undefined;
  /** How many of the person's last turns of the thread the router is shown; absent, it is shown none. */
  readonly contextTurns?: () => number | undefined;
  /** The keys the summary's tokens are sealed under; absent, no summary token opens. */
  readonly summaryKeys?: () => TokenKeys | undefined;
  /** The store of the confirmations that wait for the analyst; absent, a heavy step of the loop stops the turn as Ask's heavy stop, with Continue. */
  readonly pending?: () => AssistantPendingStore | undefined;
  readonly now?: () => number;
}

/** The keyed hash of what the person typed, made with the application's signing key, so a short message cannot be confirmed by guessing; absent when the application has no key. */
const hashOf = (request: ExtensionRequest, parts: readonly unknown[]): { readonly questionHash?: string } => (request.signText === undefined ? {} : { questionHash: request.signText(canonicalText(parts)) });

const unsupported = (): ExtensionRefusal => new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });

const refused = (cause: Extract<AssistantTurnAnswer, { route: 'refuse' }>['cause']): AssistantTurnAnswer => ({ status: 'answered', route: 'refuse', cause, sentence: ASSISTANT_REFUSAL_SENTENCES[cause] });

const kindOf = (code: FailureCode | 'refused'): AssistantFailureKind => (code === 'timeout' ? 'timeout' : code === 'rate-limited' ? 'rate-limit' : 'service');

/** A failure of the gate's read that is the person's to retry, as the answer of a turn; every other refusal goes on as the gate gave it, as Ask gives it. */
function unavailableOf(error: unknown): AssistantTurnAnswer | undefined {
  if (!(error instanceof ExtensionRefusal)) return undefined;
  switch (error.code) {
    case 'QUERY_TIMEOUT':
      return { status: 'unavailable', kind: 'timeout', readStarted: true };
    case 'SOURCE_UNAVAILABLE':
      return { status: 'unavailable', kind: 'source-unavailable', readStarted: true };
    case 'SOURCE_BUSY':
      return { status: 'unavailable', kind: 'busy', readStarted: true };
    case 'RATE_LIMITED':
      return { status: 'unavailable', kind: 'rate-limit', readStarted: true, ...(error.retryAfterMs === undefined ? {} : { retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterMs / MILLISECONDS_A_SECOND)) }) };
    default:
      return undefined;
  }
}

const summaryInvalid = (): AssistantTurnAnswer => ({ status: 'summary-invalid', sentence: ASSISTANT_SUMMARY_INVALID_SENTENCE });

const answeredAsk = (answer: AskAnswer, reads?: readonly AssistantRead[], stoppedAt?: AssistantLimit): AssistantTurnAnswer => {
  if ('refused' in answer || answer.answered.continueToken !== undefined) return { status: 'answered', route: 'ask', answer };
  const { result, intent } = answer.answered;
  return { status: 'answered', route: 'ask', answer, reads: [...(reads ?? [readOfAnswer(answer.answered.patternName === undefined ? 'intent' : 'pattern', intent, answer.answered)])], coverage: coverageOf(result), ...(stoppedAt === undefined ? {} : { stoppedAt }) };
};

/** The answer of a turn for what the view answer came to; every exit has one. */
function viewTurn(outcome: ViewOutcome): AssistantTurnAnswer {
  switch (outcome.status) {
    case 'answered':
      return outcome.answer;
    case 'unsupported':
    case 'tool':
      return { status: 'not-answered', route: 'view', sentence: ASSISTANT_NOT_ANSWERED_SENTENCE };
    case 'summary-invalid':
      return summaryInvalid();
    case 'invalid-keys':
      throw new ExtensionRefusal({ code: 'INVALID_REQUEST', reason: 'view-keys' });
    case 'cancelled':
      throw new Error('the request was cancelled');
    case 'stopped':
      if (outcome.because === 'input') return { status: 'too-large', sentence: ASSISTANT_TOO_LARGE_SENTENCE };
      return { status: 'unavailable', kind: outcome.because === 'deadline' ? 'timeout' : 'service', readStarted: outcome.readStarted };
    case 'failed':
      return { status: 'unavailable', kind: outcome.kind, readStarted: outcome.readStarted };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

/** The candidates of a clarification with the title the analyst sees: an element only the view holds was keyed by its id, so its title is read through the gate, masked as this message asks. */
async function titledFromView(candidates: readonly Candidate[], context: TurnContext, body: { readonly investigationId: string; readonly sourceId: string; readonly mask?: boolean | undefined }, readElements: ExtensionRequest['readElements'], signal: AbortSignal): Promise<readonly Candidate[]> {
  const viewKeys = new Set([...(context.fromView ?? [])].flatMap((key) => context.keys.get(key) ?? []).map(canonical));
  const wanted = candidates.filter((candidate) => viewKeys.has(canonical(candidate.ref)));
  if (wanted.length === 0 || readElements === undefined) return candidates;
  const reading = await readElements({ investigationId: body.investigationId, sourceId: body.sourceId, mask: body.mask === true, signal }, { entities: wanted.map((candidate) => candidate.ref), edges: [], aggregates: [], derived: [] });
  return candidates.flatMap((candidate) => {
    if (!wanted.includes(candidate)) return [candidate];
    const node = reading.nodes.find((read) => read.ref.sourceId === candidate.ref.sourceId && read.ref.entityType === candidate.ref.entityType && read.ref.stableId === candidate.ref.stableId);
    return node === undefined ? [] : [{ ref: candidate.ref, title: node.display.title, type: node.display.type }];
  });
}

/** The values of an `ask` reply: the typed ones, and for each role the router named by a key of the context the stable ID of that key's element; or the roles whose key names nothing of this turn's context. */
function entitiesOfReply(reply: Extract<AssistantRouterReply, { route: 'ask' }>, context: TurnContext | undefined, entityTypeOf: (role: string) => string | undefined = () => undefined): { readonly entities: AskEntities; readonly unheld?: undefined } | { readonly entities: AskEntities; readonly unheld: readonly string[] } {
  const named = Object.entries(reply.elements ?? {});
  const resolved: Record<string, string> = { ...reply.entities };
  const unheld: string[] = [];
  for (const [role, key] of named) {
    const ref = context?.keys.get(key);
    const wanted = entityTypeOf(role);
    // a key of an element of another entity type than the role takes names nothing for it
    if (ref === undefined || (wanted !== undefined && ref.entityType !== wanted)) unheld.push(role);
    else resolved[role] = ref.stableId;
  }
  return unheld.length === 0 ? { entities: resolved } : { entities: resolved, unheld };
}

/** The values of a clarification's other roles: the typed ones, and each role named by a key of the context as the stable ID of that key's element. */
function othersOfClarify(reply: Extract<AssistantRouterReply, { route: 'clarify' }>, context: TurnContext | undefined): AskEntities {
  const resolved: Record<string, string> = { ...reply.entities };
  for (const [role, key] of Object.entries(reply.elements ?? {})) {
    const ref = context?.keys.get(key);
    if (ref !== undefined) resolved[role] = ref.stableId;
  }
  return resolved;
}

/** What a loop that ran steps answers: the answer of its last read, the confirmation a heavy step waits for, the stop of a limit, or the fixed sentence of a request that did not fit. A turn that went on after a decision always has an answer. */
async function loopAnswer(outcome: LoopOutcome, route: 'ask' | 'view', onWaiting: (waiting: Extract<LoopOutcome, { kind: 'waiting' }>) => Promise<AssistantTurnAnswer>, resumed = false): Promise<AssistantTurnAnswer | undefined> {
  switch (outcome.kind) {
    case 'finished':
      return resumed || outcome.steps > 1 || outcome.stoppedAt !== undefined ? answeredAsk({ answered: outcome.answer }, outcome.reads, outcome.stoppedAt) : undefined;
    case 'waiting':
      return onWaiting(outcome);
    case 'limit':
      return { status: 'limit', limit: outcome.limit, sentence: ASSISTANT_LIMIT_SENTENCES[outcome.limit], reads: [...outcome.reads] };
    case 'sentences':
      return { status: 'answered', route, sentences: [...outcome.answer.sentences], citations: outcome.answer.citations, coverage: outcome.answer.coverage, model: outcome.answer.model, calls: outcome.calls, steps: outcome.steps, reads: [...outcome.reads], ...(outcome.stoppedAt === undefined ? {} : { stoppedAt: outcome.stoppedAt }) };
    case 'unsupported':
      return { status: 'not-answered', route, sentence: ASSISTANT_NOT_ANSWERED_SENTENCE };
    case 'failed':
      return { status: 'unavailable', kind: outcome.why, readStarted: true };
    case 'ended':
      return { status: 'answered', route: 'refuse', cause: 'unplaced', sentence: ASSISTANT_REFUSAL_SENTENCES.unplaced };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

async function runAndAnswer(run: Execution, followUps?: (answer: AskAnswer) => readonly FollowUp[], after?: (answer: AskAnswer) => Promise<AssistantTurnAnswer | undefined>): Promise<AssistantTurnAnswer> {
  if (run.request.signal.aborted) throw new Error('the request was cancelled');
  try {
    const answer = await execute(run);
    const looped = after === undefined ? undefined : await after(answer);
    if (looped !== undefined) return looped;
    const turn = answeredAsk(answer);
    const chips = followUps?.(answer) ?? [];
    return turn.status === 'answered' && turn.route === 'ask' && chips.length > 0 ? { ...turn, followUps: chips.map((chip) => ({ titles: [...chip.titles], choice: chip.choice })) } : turn;
  } catch (error) {
    const unavailable = unavailableOf(error);
    if (unavailable === undefined) throw error;
    return unavailable;
  }
}

export function createAssistantTurnRoute(options: TurnRouteOptions): ExtensionRoute {
  const runOptions = { folder: options.folder, runs: () => undefined, logger: options.logger, ...(options.now === undefined ? {} : { now: options.now }) };

  /** The last turns of this person's thread as the router is shown them, read again through the gate; a failure of the gate's read is the caller's to answer. */
  async function contextOf(body: Extract<AssistantTurnRequest, { message: string }>, readElements: ExtensionRequest['readElements'], signal: AbortSignal): Promise<TurnContext | undefined> {
    const limit = options.contextTurns?.();
    if (limit === undefined || readElements === undefined) return undefined;
    const turns = await readTurnContext(limit);
    return buildContext({ turns, sourceId: body.sourceId, read: (refs) => readElements({ investigationId: body.investigationId, sourceId: body.sourceId, mask: body.mask === true, signal }, refs) });
  }

  /** A key the router named that is not an element of the context: the elements it may mean, as a clarification, or the fixed refusal when there are none or more than one role is in doubt. */
  async function clarifyUnheld(request: ExtensionRequest, reply: Extract<AssistantRouterReply, { route: 'ask' }>, unheld: readonly string[], others: AskEntities, context: TurnContext | undefined, body: Extract<AssistantTurnRequest, { message: string }>, readElements: ExtensionRequest['readElements'], signal: AbortSignal): Promise<AssistantTurnAnswer> {
    const [role] = unheld;
    const intent = options.folder()?.intent(body.sourceId, reply.intent);
    const entityType = role === undefined || unheld.length > 1 || intent === undefined ? undefined : roleEntityType(intent, role);
    if (entityType === undefined) return refused('unplaced');
    const view = readViewKeys(body.viewElementKeys, body.sourceId);
    const read = (refs: ElementRefs) => (readElements === undefined ? Promise.resolve({ nodes: [], edges: [], unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact' as const, scope: 'coverage' }, uncounted: 0 }) : readElements({ investigationId: body.investigationId, sourceId: body.sourceId, mask: body.mask === true, signal }, refs));
    const candidates = await candidatesFor({ entityType, context, viewEntities: view.ok ? view.refs.entities : [], read });
    return candidates.length === 0 || role === undefined ? refused('unplaced') : clarificationAnswer(candidates, choicesOf(request, body, reply.intent, role, others, Object.keys(reply.elements ?? {}).filter((held) => !unheld.includes(held))));
  }

  /** Seals what a choice or a follow-up sends: the intent, the roles whose value is an element, the values, and the token that binds them to this person, investigation, intent definition and masking. */
  function sealOf(request: ExtensionRequest, body: { readonly sourceId: string; readonly investigationId: string; readonly mask?: boolean | undefined }): (intentName: string, roles: readonly string[], entities: AskEntities) => AssistantChoice {
    const { signText } = capabilitiesOf(request);
    return (intentName, roles, entities) => {
      const found = options.folder()?.intent(body.sourceId, intentName);
      const binding = { principalId: request.principalId, sourceId: body.sourceId, investigationId: body.investigationId, intent: intentName, definition: found === undefined ? '' : definitionOf(found), roles, entities, mask: body.mask === true };
      return { intent: intentName, roles: [...roles], entities, choiceToken: issueChoiceToken(signText, binding, (options.now ?? Date.now)()) };
    };
  }

  /** What each candidate of a clarification sends when it is picked: the values with the candidate's own for the role, and the roles that are elements. */
  function choicesOf(request: ExtensionRequest, body: { readonly sourceId: string; readonly investigationId: string; readonly mask?: boolean | undefined }, intentName: string, role: string, others: AskEntities, elementRoles: readonly string[]): (candidate: Candidate) => AssistantChoice {
    const seal = sealOf(request, body);
    return (candidate) => seal(intentName, [role, ...elementRoles], { ...others, [role]: candidate.ref.stableId });
  }

  /** The follow-ups of an answered Ask turn: other template questions of the folder the elements of the answer can be put to, each sealed. */
  function followUpsFor(request: ExtensionRequest, body: { readonly sourceId: string; readonly investigationId: string; readonly mask?: boolean | undefined }): (answer: AskAnswer) => readonly FollowUp[] {
    const seal = sealOf(request, body);
    return (answer) => followUpsOf({ answer, folder: options.folder(), sourceId: body.sourceId, seal });
  }

  /** A choice of a clarification or a follow-up: the token is checked against exactly what it binds, each element it fills is read again through the gate, and only then the intent runs, with no model call. */
  async function choiceTurn(request: ExtensionRequest, body: Extract<AssistantTurnRequest, { choice: unknown }>, readElements: ExtensionRequest['readElements'], signal: AbortSignal, deadline: AbortSignal): Promise<AssistantTurnAnswer> {
    const { choice } = body;
    const found = options.folder()?.intent(body.sourceId, choice.intent);
    const invalid: AssistantTurnAnswer = { status: 'choice-invalid', sentence: ASSISTANT_CHOICE_INVALID_SENTENCE };
    if (found === undefined || readElements === undefined || new Set(choice.roles).size !== choice.roles.length) return invalid;
    const wanted: { readonly sourceId: string; readonly entityType: string; readonly stableId: string }[] = [];
    for (const role of choice.roles) {
      const entityType = roleEntityType(found, role);
      const value = choice.entities[role];
      if (entityType === undefined || value === undefined || !found.parameters.includes(role)) return invalid;
      wanted.push({ sourceId: body.sourceId, entityType, stableId: value });
    }
    const binding = { principalId: request.principalId, sourceId: body.sourceId, investigationId: body.investigationId, intent: choice.intent, definition: definitionOf(found), roles: choice.roles, entities: choice.entities, mask: body.mask === true };
    if (!verifyChoiceToken(capabilitiesOf(request).signText, choice.choiceToken, binding, (options.now ?? Date.now)())) return invalid;
    let reading;
    try {
      reading = await readElements({ investigationId: body.investigationId, sourceId: body.sourceId, mask: body.mask === true, signal }, { entities: wanted, edges: [], aggregates: [], derived: [] });
    } catch (error) {
      if (request.signal.aborted) throw new Error('the request was cancelled');
      const unavailable = unavailableOf(error) ?? (deadline.aborted ? ({ status: 'unavailable', kind: 'timeout', readStarted: true } as const) : undefined);
      if (unavailable === undefined) throw error;
      return unavailable;
    }
    if (!wanted.every((ref) => reading.nodes.some((node) => node.ref.entityType === ref.entityType && node.ref.stableId === ref.stableId))) return invalid;
    return runAndAnswer({ request, capabilities: capabilitiesOf(request), options: runOptions, sourceId: body.sourceId, mask: body.mask === true, intent: choice.intent, entities: choice.entities, continuing: false, action: ASK_ACTION, investigationId: body.investigationId }, followUpsFor(request, body));
  }
  /** The continue of a heavy stop finds a catalog template that a tool step of the loop ran, which the router's own `ask` reply never does. */
  const continueOptions = { ...runOptions, folder: () => withTemplateTools(options.folder()) };

  async function continueTurn(request: ExtensionRequest, body: AssistantTurnRequest, asked: Extract<AssistantTurnRequest, { continue: unknown }>['continue']): Promise<AssistantTurnAnswer> {
    const capabilities = capabilitiesOf(request);
    const mask = body.mask === true;
    let offer: AskPatternOffer | undefined;
    let definition: string | undefined;
    if (asked.intent === ASK_SAVED_PATTERN_INTENT) {
      const { findPattern } = gateClientOf(request);
      if (findPattern === undefined) throw unsupported();
      offer = await patternOf(findPattern, body.sourceId, asked.entities);
      definition = offer === undefined ? undefined : patternDefinitionOf(offer);
    } else {
      const found = continueOptions.folder()?.intent(body.sourceId, asked.intent);
      definition = found === undefined ? undefined : definitionOf(found);
    }
    const binding = { principalId: request.principalId, sourceId: body.sourceId, intent: asked.intent, definition: definition ?? '', entities: asked.entities, mask, investigationId: body.investigationId };
    if (definition === undefined || !verifyContinueToken(capabilities.signText, asked.continueToken, binding, (options.now ?? Date.now)())) {
      await writeEvent(request, CONTINUE_ACTION, 'refused', body.sourceId, { kind: 'template', outcome: 'refused', cause: 'continue-invalid' });
      return { status: 'continue-invalid', sentence: ASSISTANT_CONTINUE_INVALID_SENTENCE };
    }
    return runAndAnswer({ request, capabilities, options: continueOptions, sourceId: body.sourceId, mask, intent: asked.intent, entities: asked.entities, continuing: true, action: CONTINUE_ACTION, investigationId: body.investigationId, ...(offer === undefined ? {} : { offer }) }, followUpsFor(request, body));
  }

  /** The fingerprint of the definition of a tool a plan waits on, as the continue of Ask binds it: a folder intent or catalog template by its definition, a saved pattern by its id and version. */
  async function definitionOfTool(request: ExtensionRequest, sourceId: string, tool: string, values: Readonly<Record<string, string>>): Promise<string | undefined> {
    const found = continueOptions.folder()?.intent(sourceId, tool);
    if (found !== undefined) return definitionOf(found);
    const { findPattern } = gateClientOf(request);
    if (findPattern === undefined) return undefined;
    const offer = await patternOf(findPattern, sourceId, { pattern: tool, ...values });
    return offer === undefined ? undefined : patternDefinitionOf(offer);
  }

  /** What a turn that waits for a confirmation needs to keep it; a heavy step with no store to keep it in stops the turn as Ask's heavy stop does. */
  function waitingOf(request: ExtensionRequest, body: { readonly sourceId: string; readonly investigationId: string; readonly mask?: boolean | undefined; readonly viewElementKeys: readonly string[] }, message: string, startedAt: number): (waiting: Extract<LoopOutcome, { kind: 'waiting' }>) => Promise<AssistantTurnAnswer> {
    return (waiting) => {
      const store = options.pending?.();
      if (store === undefined) return Promise.resolve(answeredAsk({ answered: waiting.wait.answer }));
      const ctx: WaitContext = { request, sourceId: body.sourceId, investigationId: body.investigationId, mask: body.mask === true, message, viewElementKeys: body.viewElementKeys, startedAt, now: options.now ?? Date.now, store, definitionOf: (tool, values) => definitionOfTool(request, body.sourceId, tool, values) };
      return waitingAnswer(ctx, waiting);
    };
  }

  /** A new message drops the confirmation the person was waiting on: the step can never run. A store that cannot be reached never blocks the message. */
  async function dropWaiting(request: ExtensionRequest, body: { readonly sourceId: string; readonly investigationId: string }): Promise<void> {
    const store = options.pending?.();
    if (store === undefined) return;
    try {
      const dropped = await store.drop(request.principalId, (options.now ?? Date.now)());
      if (dropped !== undefined) await auditConfirmation(request, dropped, 'replaced');
    } catch {
      // the old row stays until it expires, usable only by the same person
    }
  }

  /** The decision of the analyst on a waiting confirmation: verified, claimed once, and then the turn goes on, or ends if it was a cancel. */
  async function confirmationTurn(request: ExtensionRequest, body: Extract<AssistantTurnRequest, { confirmation: unknown }>, signal: AbortSignal): Promise<AssistantTurnAnswer> {
    const store = options.pending?.();
    if (store === undefined) throw unsupported();
    const now = options.now ?? Date.now;
    const mask = body.mask === true;
    // what a decision needs is checked before the confirmation is claimed, so a missing loop never uses it up
    const loop = options.toolLoop?.();
    if (loop === undefined) return { status: 'unavailable', kind: 'service', readStarted: false };
    const { patterns } = gateClientOf(request);
    const listing = patterns === undefined ? undefined : await patterns(body.sourceId);
    const built = listing === undefined ? undefined : buildPatternCatalog(listing);
    const scope = { request, capabilities: capabilitiesOf(request), options: runOptions, action: ASK_ACTION, sourceId: body.sourceId, mask, investigationId: body.investigationId, viewElementKeys: body.viewElementKeys, ...(built === undefined || listing === undefined ? {} : { patterns: { built, listing } }) };
    const registry = toolRegistryOf(scope, body.viewElementKeys.length > 0);
    const decided = await openDecision({ request, sourceId: body.sourceId, investigationId: body.investigationId, mask, now, store, definitionOf: (tool, values) => definitionOfTool(request, body.sourceId, tool, values), toolAvailable: (tool) => registry.find(tool)?.available === true }, body);
    if (decided.kind === 'answer') return decided.answer;
    const { plan } = decided;
    noteTurn({ route: 'ask' });
    if (plan.runId !== undefined) noteResumes(plan.runId);
    const route = plan.fromView ? 'view' : 'ask';
    const total = options.totalTimeoutMs?.();
    // the time of the wait does not count: the turn has the time it had left when it stopped
    const remaining = total === undefined ? undefined : total - plan.counters.elapsedMs;
    const deadline = remaining === undefined ? new AbortController().signal : remaining <= 0 ? AbortSignal.abort() : (options.turnDeadline ?? AbortSignal.timeout)(remaining);
    const startedAt = now() - plan.counters.elapsedMs;
    try {
      const looped = await loop({ scope, message: body.message, deadline: AbortSignal.any([deadline, signal]), startedAt, callsUsed: plan.counters.calls, resume: decided.resume });
      if (looped === undefined) return { status: 'unavailable', kind: 'service', readStarted: true };
      return (await loopAnswer(looped, route, waitingOf(request, body, body.message, startedAt), true)) ?? { status: 'unavailable', kind: 'service', readStarted: true };
    } catch (error) {
      if (error instanceof AuditUnavailableError) throw new ExtensionRefusal({ code: 'AUDIT_UNAVAILABLE' });
      if (request.signal.aborted) throw new Error('the request was cancelled');
      const unavailable = unavailableOf(error) ?? (deadline.aborted ? ({ status: 'unavailable', kind: 'timeout', readStarted: true } as const) : undefined);
      if (unavailable === undefined) throw error;
      return unavailable;
    }
  }

  return {
    method: 'POST',
    url: TURNS_URL,
    permission: 'principal',
    requestSchema: assistantTurnRequestSchema,
    responseSchema: assistantTurnAnswerSchema,
    handler: withTurnAudit({ logger: options.logger, ...(options.runs === undefined ? {} : { runs: options.runs }), ...(options.runSettings === undefined ? {} : { settings: options.runSettings }), ...(options.threads === undefined ? {} : { threads: options.threads }), ...(options.records === undefined ? {} : { records: options.records }), ...(options.now === undefined ? {} : { now: options.now }) }, async (request: ExtensionRequest): Promise<AssistantTurnAnswer> => {
      const { sourceReadable, investigationReadable, patterns, readElements, typeDescriptions: describe } = gateClientOf(request);
      const router = options.router();
      if (sourceReadable === undefined || investigationReadable === undefined || router === undefined) throw unsupported();
      const startedAt = (options.now ?? Date.now)();
      const total = options.totalTimeoutMs?.();
      const deadline = total === undefined ? new AbortController().signal : (options.turnDeadline ?? AbortSignal.timeout)(total);
      const body = assistantTurnRequestSchema.parse(request.body);
      await sourceReadable(body.sourceId);
      await investigationReadable(body.investigationId, body.sourceId);
      const typeDescriptions = describe?.(body.sourceId);
      if ('choice' in body) {
        await noteTurnStarted({ sourceId: body.sourceId, investigationId: body.investigationId, ...hashOf(request, ['assistant-choice', 1, body.choice.intent]) });
        return choiceTurn(request, body, readElements, AbortSignal.any([request.signal, deadline]), deadline);
      }
      if ('confirmation' in body) {
        await noteTurnStarted({ sourceId: body.sourceId, investigationId: body.investigationId, ...hashOf(request, ['assistant-confirmation', 1, body.message]) });
        return confirmationTurn(request, body, AbortSignal.any([request.signal, deadline]));
      }
      if ('continue' in body) {
        await noteTurnStarted({ sourceId: body.sourceId, investigationId: body.investigationId, ...hashOf(request, ['assistant-continue', 1, body.continue.intent]) });
        return continueTurn(request, body, body.continue);
      }
      const { message } = body;
      const words = countWords(message);
      if (words === 0) throw new ExtensionRefusal({ code: 'INVALID_REQUEST', reason: 'empty-message' });
      await noteTurnStarted({ sourceId: body.sourceId, investigationId: body.investigationId, ...hashOf(request, ['assistant-question', 1, message]) });
      await dropWaiting(request, body);
      const limit = options.maxMessageWords();
      if (limit === undefined) throw unsupported();
      if (words > limit) return { status: 'too-long', words, limit };
      // the keys are the client's: they are read back into references before any model sees the message
      if (options.viewAnswer?.() !== undefined && !readViewKeys(body.viewElementKeys, body.sourceId).ok) throw new ExtensionRefusal({ code: 'INVALID_REQUEST', reason: 'view-keys' });
      let summary: SummaryAttachment | undefined;
      if (body.summaryToken !== undefined) {
        // opened before anything is read or sent: a token that does not open ends the turn here, whatever the cause
        summary = openAttachment(options.summaryKeys?.(), body.summaryToken, { sourceId: body.sourceId, investigationId: body.investigationId, actorId: request.principalId, policyVersion: request.policyVersion?.(body.sourceId) ?? 'none', now: (options.now ?? Date.now)() });
        if (summary === undefined) return summaryInvalid();
      }
      const listing = patterns === undefined ? undefined : await patterns(body.sourceId);
      const built = listing === undefined ? undefined : buildPatternCatalog(listing);
      let context: TurnContext | undefined;
      try {
        context = await contextOf(body, readElements, AbortSignal.any([request.signal, deadline]));
      } catch (error) {
        if (request.signal.aborted) throw new Error('the request was cancelled');
        const unavailable = unavailableOf(error) ?? (deadline.aborted ? ({ status: 'unavailable', kind: 'timeout', readStarted: true } as const) : undefined);
        if (unavailable === undefined) throw error;
        return unavailable;
      }
      // the elements in view get keys of the same table as the thread's context, so that "this account" can be named; a key resolves only to a reference of the view or the thread
      const viewRead = readViewKeys(body.viewElementKeys, body.sourceId);
      const routed = withView(context, viewRead.ok ? viewRead.refs : { entities: [], edges: [], aggregates: [], derived: [] }, body.sourceId);
      let outcome: RouterOutcome;
      try {
        outcome = await router({ sourceId: body.sourceId, investigationId: body.investigationId, message, viewElementKeys: body.viewElementKeys, ...(routed.viewText === undefined ? {} : { viewText: routed.viewText }), actorId: request.principalId, actorRole: request.principalRole, traceId: request.traceId, ...(context === undefined && summary === undefined ? {} : { context: [context?.text, summary === undefined ? undefined : ATTACHED_SUMMARY_LINE].filter((part) => part !== undefined).join('\n\n') }), accepts: (reply) => reply.route !== 'clarify' || candidatesOfReply(reply, routed, options.folder(), body.sourceId) !== undefined, ...(built === undefined ? {} : { patternCatalog: built.catalog.text }) }, AbortSignal.any([request.signal, deadline]));
      } catch (error) {
        // the model returned a prompt other than the one sent, so nothing of the call is kept
        if (error instanceof AuditUnavailableError) throw new ExtensionRefusal({ code: 'AUDIT_UNAVAILABLE' });
        throw error;
      }
      switch (outcome.status) {
        case 'too-large':
          return { status: 'too-large', sentence: ASSISTANT_TOO_LARGE_SENTENCE };
        case 'failed':
          return { status: 'unavailable', kind: kindOf(outcome.code), readStarted: false };
        case 'unplaced':
          return refused('unplaced');
        case 'routed': {
          const { reply } = outcome;
          if (reply.route === 'refuse') return refused(reply.cause);
          if (reply.route === 'clarify') {
            const found = candidatesOfReply(reply, routed, options.folder(), body.sourceId);
            let candidates: readonly Candidate[] | undefined;
            try {
              candidates = found === undefined ? undefined : await titledFromView(found, routed, body, readElements, AbortSignal.any([request.signal, deadline]));
            } catch (error) {
              if (error instanceof AuditUnavailableError) throw new ExtensionRefusal({ code: 'AUDIT_UNAVAILABLE' });
              if (request.signal.aborted) throw new Error('the request was cancelled');
              const unavailable = unavailableOf(error) ?? (deadline.aborted ? ({ status: 'unavailable', kind: 'timeout', readStarted: true } as const) : undefined);
              if (unavailable === undefined) throw error;
              return unavailable;
            }
            return candidates === undefined || candidates.length === 0 ? refused('unplaced') : clarificationAnswer(candidates, choicesOf(request, body, reply.intent, reply.role, othersOfClarify(reply, routed), Object.keys(reply.elements ?? {})));
          }
          if (reply.route === 'view') {
            noteTurn({ route: 'view' });
            const answerView = options.viewAnswer?.();
            if (answerView === undefined || readElements === undefined) return { status: 'not-answered', route: 'view', sentence: ASSISTANT_NOT_ANSWERED_SENTENCE };
            if (request.principalRole !== 'administrator' && request.principalRole !== 'investigator') throw new ExtensionRefusal({ code: 'ACCESS_DENIED' });
            const progress: ViewProgress = { calls: 0, read: 0, readStarted: false };
            try {
              const capabilities = capabilitiesOf(request);
              const scope = { request, capabilities, options: runOptions, action: ASK_ACTION, sourceId: body.sourceId, mask: body.mask === true, investigationId: body.investigationId, viewElementKeys: body.viewElementKeys, ...(built === undefined || listing === undefined ? {} : { patterns: { built, listing } }) };
              const loop = options.toolLoop?.();
              const tools = loop !== undefined && options.viewTools?.() === true && options.folder()?.source(body.sourceId) !== undefined ? toolRegistryOf(scope, false) : undefined;
              const viewed = await answerView({ sourceId: body.sourceId, investigationId: body.investigationId, mask: body.mask === true, message, viewElementKeys: body.viewElementKeys, actorId: request.principalId, actorRole: request.principalRole, traceId: request.traceId, readElements, signal: request.signal, deadline, callsUsed: outcome.calls, startedAt, progress, ...(summary === undefined ? {} : { summary }), ...(tools === undefined ? {} : { tools }), ...(context === undefined ? {} : { context: context.text }), ...(typeDescriptions === undefined ? {} : { typeDescriptions }) });
              if (viewed.summary !== undefined) noteTurn({ summary: viewed.summary });
              if (viewed.status === 'tool' && loop !== undefined) {
                // the view's reading is the first step of the loop; the model's request is the second
                noteStep();
                const looped = await loop({ scope, message, deadline, startedAt, callsUsed: outcome.calls + viewed.calls, ...(context === undefined ? {} : { context: context.text }), view: { reading: viewed.reading, assembled: viewed.assembled, request: viewed.request } });
                return looped === undefined ? viewTurn(viewed) : ((await loopAnswer(looped, 'view', waitingOf(request, body, message, startedAt))) ?? viewTurn(viewed));
              }
              return viewTurn(viewed);
            } catch (error) {
              if (error instanceof AuditUnavailableError) throw new ExtensionRefusal({ code: 'AUDIT_UNAVAILABLE' });
              // the gate's own refusal of the read, with no partial answer; every other refusal goes on as the gate gave it
              const unavailable = unavailableOf(error);
              if (unavailable === undefined) throw error;
              return unavailable;
            }
          }
          const capabilities = capabilitiesOf(request);
          if (options.folder()?.source(body.sourceId) === undefined) {
            await writeEvent(request, ASK_ACTION, 'refused', body.sourceId, { kind: 'template', outcome: 'refused', cause: 'no-ask-for-source' });
            return answeredAsk(refusal('no-ask-for-source'));
          }
          const intentOfReply = options.folder()?.intent(body.sourceId, reply.intent);
          const resolved = entitiesOfReply(reply, routed, (role) => (intentOfReply === undefined ? undefined : roleEntityType(intentOfReply, role)));
          if (resolved.unheld !== undefined) {
            try {
              return await clarifyUnheld(request, reply, resolved.unheld, resolved.entities, routed, body, readElements, AbortSignal.any([request.signal, deadline]));
            } catch (error) {
              if (request.signal.aborted) throw new Error('the request was cancelled');
              const unavailable = unavailableOf(error) ?? (deadline.aborted ? ({ status: 'unavailable', kind: 'timeout', readStarted: true } as const) : undefined);
              if (unavailable === undefined) throw error;
              return unavailable;
            }
          }
          const execution: Execution = { request, capabilities, options: runOptions, sourceId: body.sourceId, mask: body.mask === true, intent: reply.intent, entities: resolved.entities, continuing: false, action: ASK_ACTION, investigationId: body.investigationId, ...(built === undefined || listing === undefined ? {} : { patterns: { built, listing } }) };
          const loop = options.toolLoop?.();
          const after =
            loop === undefined
              ? undefined
              : async (answer: AskAnswer): Promise<AssistantTurnAnswer | undefined> => {
                  if ('refused' in answer || answer.answered.continueToken !== undefined) return undefined;
                  const scope = { request, capabilities, options: runOptions, action: ASK_ACTION, sourceId: body.sourceId, mask: body.mask === true, investigationId: body.investigationId, viewElementKeys: body.viewElementKeys, ...(execution.patterns === undefined ? {} : { patterns: execution.patterns }) };
                  const looped = await loop({ scope, message, deadline, startedAt, callsUsed: outcome.calls, ...(context === undefined ? {} : { context: context.text }), first: { tool: reply.intent, answer: answer.answered, asked: resolved.entities } });
                  return looped === undefined ? undefined : loopAnswer(looped, 'ask', waitingOf(request, body, message, startedAt));
                };
          return runAndAnswer(execution, followUpsFor(request, body), after);
        }
        default: {
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    }),
  };
}
