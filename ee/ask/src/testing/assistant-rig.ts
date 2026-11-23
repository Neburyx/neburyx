import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtensionRefusal, askRunResultSchema, assistantTurnAnswerSchema, type AskPatternOffer, type ElementRefs, type AskRun, type AskRunResult, type AuditEvent, type AuditSink, type ExtensionRequest, type ExtensionRoute, type RecordQueue } from '@neburyx/contracts';
import { createAuditedModelCall, createCallRecorder, createCheckRunner, type CheckRunner, type ModelProvider } from '@neburyx/ee-ai-runtime';
import { createFixtureProvider, replyKey, type FixtureReply, type FixtureReplies } from '../../../ai-runtime/src/testing/fixture.js';
import { loadAskFolder } from '../folder/load.js';
import { buildAssistantInstructions } from '../assistant/instructions.js';
import { ROUTER_PROMPT_ID, ROUTER_PROMPT_VERSION, createAssistantRouter } from '../assistant/router.js';
import { createAssistantTurnRoute } from '../assistant/turn-route.js';
import { AGENT_PROMPT_ID, AGENT_PROMPT_VERSION, createAgentTurn } from '../assistant/agent-turn.js';
import { auditChatModel, type AgentChatModel, type AgentRun } from '@neburyx/ee-assistant-agent';
import { AIMessage, fakeModel } from '@neburyx/ee-assistant-agent/testing';
import type { AssistantRunStore } from '../assistant/run-store.js';
import type { AssistantThreadStore } from '../assistant/thread-store.js';
import type { AssistantPendingStore } from '../assistant/pending-store.js';
import { readAssistantSettings } from '../assistant/settings.js';
import { OVERVIEW_PROMPT_ID, OVERVIEW_PROMPT_VERSION, OVERVIEW_AUDIT_ACTION } from '../assistant/verdict-overview.js';
import { VIEW_PROMPT_ID, VIEW_PROMPT_VERSION, createViewAnswer } from '../assistant/view-answer.js';
import { buildSummaryInstructions } from '../case-summary/instructions.js';
import type { TokenKeys } from '../case-summary/token-keys.js';
import { makeAskFolder } from './ask-folder.js';
import { UNAVAILABLE_SUMMARIZER } from './case-summarizer.js';

const SOURCE = 'demo';
/** The words the scripted suites use for the elements of their source: invented ones, or those of a shipped pack when `NEBURYX_TEST_PACK` names it, so that the same suites run on another data model with no change of code. */
interface Vocabulary {
  readonly anchor: string;
  readonly other: string;
  /** The label of the anchor type, as it begins a title: "Widget A-1". */
  readonly titleOf: (stableId: string) => string;
  readonly links: readonly [string, string];
}

function vocabularyOf(pack: string | undefined): Vocabulary {
  if (pack === undefined || pack === '') return { anchor: 'widget', other: 'gadget', titleOf: (stableId) => `Account ${stableId}`, links: ['HOLDS', 'SENT'] };
  const lines = readFileSync(fileURLToPath(new URL(`../../../../domain-packs/${pack}/neburyx.yaml`, import.meta.url)), 'utf8').split('\n');
  const at = lines.findIndex((line) => /^ {4}relationships:/u.test(line));
  if (at < 0) throw new Error(`the pack ${pack} names no relationships`);
  // the entities and relationships of the first source are list items at one indent: a `- type:` deeper down belongs to a list inside one of them
  const itemsOf = (part: readonly string[]): { type: string; label: string }[] =>
    part.flatMap((line, index) => {
      const type = /^ {6}- type: (\S+)$/u.exec(line)?.[1];
      if (type === undefined) return [];
      const block = part.slice(index + 1).findIndex((next) => /^ {6}- type:/u.test(next));
      const own = part.slice(index + 1, block < 0 ? undefined : index + 1 + block);
      return [{ type, label: own.map((next) => /^ {8}label: (.+)$/u.exec(next)?.[1]).find((found) => found !== undefined) ?? '' }];
    });
  const types = itemsOf(lines.slice(0, at));
  const links = itemsOf(lines.slice(at)).map((item) => item.type);
  const [anchor, other] = types;
  if (anchor === undefined || other === undefined || links[1] === undefined) throw new Error(`the pack ${pack} has fewer than two entity types or relationship types`);
  if (/\s/u.test(anchor.label) || anchor.label === '') throw new Error(`the label of the first entity type of the pack ${pack} is empty or has a space`);
  return { anchor: anchor.type, other: other.type, titleOf: (stableId) => `${anchor.label} ${stableId}`, links: [links[0] ?? '', links[1]] };
}

const VOCABULARY = vocabularyOf(process.env['NEBURYX_TEST_PACK']);
/** The vocabulary of the suites, with the word that begins a title: "Account A-1" has "Account". */
export const V = { ...VOCABULARY, title: VOCABULARY.titleOf('x').split(' ')[0] ?? '' };
const NOW = 1_800_000_000_000;
const CLASSIFICATION = 'Choose the intent that answers the question. SENTINEL-CLASSIFICATION';
const PROMPT = 'You route messages. SENTINEL-PROMPT';
export const MESSAGE = 'Which accounts share a device with SENTINEL-MESSAGE?';
export const VIEW_KEYS = [JSON.stringify(['node', SOURCE, V.anchor, 'A-1']), JSON.stringify(['node', SOURCE, V.anchor, 'A-2'])];
export const BODY = { sourceId: SOURCE, investigationId: 'inv-1', message: MESSAGE, viewElementKeys: ['n1', 'n2'] };
export const VIEW_BODY = { ...BODY, viewElementKeys: VIEW_KEYS };
export const sign = (text: string): string => createHmac('sha256', 'a-test-key').update(text).digest('hex');
export const ok = (text: string): FixtureReply => ({ kind: 'ok', text, usage: { kind: 'known', inputTokens: 20, outputTokens: 10 } });
export const routeAsk = (intent: string, entities: Record<string, string>): FixtureReply => ok(JSON.stringify({ route: 'ask', intent, entities }));

const node = (stableId: string, title = V.titleOf(stableId)) => ({ ref: { sourceId: SOURCE, entityType: V.anchor, stableId }, display: { title, type: V.anchor }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
export const okResult = (): AskRunResult =>
  askRunResultSchema.parse({ templateId: 'shared-attribute', result: { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: { quality: 'exact', value: 1, scope: 'test' }, matchIds: [node('A-2').ref], nodes: [node('A-1'), node('A-2')], edges: [], notices: [], warnings: [] } });
/** A read of the shared-attribute template that found no match: the anchor only, with an exact zero. */
export const zeroResult = (): AskRunResult =>
  askRunResultSchema.parse({ templateId: 'shared-attribute', result: { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: { quality: 'exact', value: 0, scope: 'test' }, matchIds: [], nodes: [node('A-1')], edges: [], notices: [], warnings: [] } });
/** A read whose count is a lower bound above what it lists, and one whose count is not known. */
export const lowerBoundResult = (): AskRunResult =>
  askRunResultSchema.parse({ templateId: 'shared-attribute', result: { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: { quality: 'lowerBound', value: 150, scope: 'test' }, matchIds: [node('A-2').ref], nodes: [node('A-1'), node('A-2')], edges: [], notices: [], warnings: [] } });
export const unknownCountResult = (): AskRunResult =>
  askRunResultSchema.parse({ templateId: 'shared-attribute', result: { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: { quality: 'unknown', scope: 'test' }, matchIds: [node('A-2').ref], nodes: [node('A-1'), node('A-2')], edges: [], notices: [], warnings: [] } });
/** A degree preview of A-1: the relationship ends in all and by the type at the other end, each with its quality. */
export const degreeResult = (): AskRunResult =>
  askRunResultSchema.parse({
    templateId: 'degree-preview',
    result: {
      ref: node('A-1').ref,
      total: { quality: 'exact', value: 184533, scope: 'test' },
      byType: [{ relationshipType: V.links[0], direction: 'in', count: { quality: 'exact', value: 169756, scope: 'test' }, neighborTypes: [V.other] }],
      byNeighborType: [
        { entityType: V.other, count: { quality: 'exact', value: 169756, scope: 'test' } },
        { entityType: V.anchor, count: { quality: 'lowerBound', value: 1000, scope: 'test' } },
      ],
      warnings: [],
      pageSize: 25,
      heavyOpThreshold: 1000,
    },
  });
/** An expansion of A-1: the anchor, two neighbours and the stored relationship to the first, with a page that has more when asked to. */
export const expandResult = (hasMore = false): AskRunResult =>
  askRunResultSchema.parse({
    templateId: 'expand',
    result: {
      ref: node('A-1').ref,
      pageSize: 25,
      nodes: [node('A-1'), node('A-2'), node('A-3')],
      edges: [{ ref: { sourceId: SOURCE, type: V.links[1], from: 'A-1', to: 'A-2', stableId: 'e-1' }, from: node('A-1').ref, to: node('A-2').ref, type: V.links[1], direction: 'out', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] }],
      pages: [{ neighborType: V.anchor, returned: 2, hasMore, matchingTotal: { quality: hasMore ? 'lowerBound' : 'exact', value: 2, scope: 'test' } }],
      warnings: [],
    },
  });
/** An expansion of A-1 that adds an element sorting before every element of the view (A-0), so that the keys of the elements shift when the read is kept. */
export const expandEarlierResult = (): AskRunResult =>
  askRunResultSchema.parse({
    templateId: 'expand',
    result: {
      ref: node('A-1').ref,
      pageSize: 25,
      nodes: [node('A-0'), node('A-1'), node('A-2')],
      edges: [],
      pages: [{ neighborType: V.anchor, returned: 1, hasMore: false, matchingTotal: { quality: 'exact', value: 1, scope: 'test' } }],
      warnings: [],
    },
  });
/** A derived rule run for A-1 with two rules: the first lists the anchor and two other ends, the second the anchor and one; the count of the second may be given. */
export const derivedRuleResult = (second: { quality: string; value?: number } = { quality: 'exact', value: 1 }): AskRunResult =>
  askRunResultSchema.parse({
    templateId: 'derived-rule-run',
    result: {
      ref: node('A-1').ref,
      results: [
        { ruleId: 'r-one', ruleVersion: 1, count: { quality: 'exact', value: 2, scope: 'derived:neighbors' }, nodes: [node('A-1'), node('A-2'), node('A-3')], edges: [], warnings: [] },
        { ruleId: 'r-two', ruleVersion: 1, count: { ...second, scope: 'derived:neighbors' }, nodes: [node('A-1'), node('A-4')], edges: [], warnings: [] },
      ],
    },
  });
export const heavyResult = (): AskRunResult =>
  askRunResultSchema.parse({ templateId: 'shared-attribute', result: { status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', estimate: { quality: 'lowerBound', value: 1000, scope: 'test' }, threshold: 1000, continueLimit: 25, notices: [], warnings: [] } });
export const fileQueryResult = (): AskRunResult =>
  askRunResultSchema.parse({ templateId: 'file-query', result: { status: 'ok', intent: 'byId', count: { quality: 'exact', value: 2, scope: 'rows' }, nodes: [node('A-1'), node('A-2')], edges: [], notices: [], warnings: [] } });

export const offerOf = (id: string, name: string): AskPatternOffer => ({
  id,
  version: 3,
  name,
  projection: { kind: 'definition', anchorType: V.anchor, startingEntity: 'held', steps: [{ relationshipTypes: ['link_a'], direction: 'out', arrivesAt: V.other, conditions: [], windowed: false }] },
});

export interface RigOptions {
  readonly reply?: FixtureReplies[string];
  readonly sink?: 'fails';
  readonly readable?: 'source' | 'investigation' | 'both';
  readonly maxInputTokens?: number;
  readonly maxMessageWords?: number;
  readonly maxCalls?: number;
  /** The lines of the typology the loop may offer as a tool; absent, none. */
  readonly typology?: readonly string[];
  /** The calls of a turn the router may spend (it repeats a reply that is not a route when there is room); absent, it makes one call. */
  readonly routerMaxCalls?: number;
  /** The limit of the view answer alone; the router keeps its own. */
  readonly viewMaxInputTokens?: number;
  readonly totalTimeoutMs?: number;
  readonly patterns?: readonly AskPatternOffer[];
  readonly noFolder?: boolean;
  readonly intents?: unknown;
  readonly run?: (continuing: boolean, asked: unknown) => AskRun | Promise<AskRun>;
  readonly runThrows?: Error;
  /** The store of the records of the turns' model calls; absent, nothing is recorded. */
  readonly runStore?: AssistantRunStore;
  /** The store of the threads, and the queue of the records its writes go through. */
  readonly threadStore?: AssistantThreadStore;
  readonly records?: RecordQueue;
  /** The store of the confirmations that wait for the analyst; absent, a heavy step of the loop stops the turn as Ask's heavy stop. */
  readonly pending?: AssistantPendingStore;
  /** The environment the assistant's settings are read from for the run record. */
  readonly settingsEnv?: Record<string, string>;
  readonly logs?: { readonly fields: Record<string, unknown>; readonly message: string }[];
  /** The reply of the model to the view answer; its presence turns the view answer on, over the two elements `VIEW_KEYS` name. */
  readonly view?: FixtureReplies[string];
  /** The reply of the model to the overview beside a verdict refusal; its presence turns the overview on (and needs the view's elements). */
  readonly overview?: FixtureReplies[string];
  readonly viewReadThrows?: Error;
  /** The read of the elements never settles, as a source that does not answer. */
  readonly viewReadHangs?: true;
  /** The title of the first element of the view. */
  readonly viewTitle?: string;
  readonly checks?: CheckRunner;
  /** The keys the summary's tokens open under; absent, no summary token opens. */
  readonly summaryKeys?: TokenKeys;
  /** Stands in for the model's service on the answer call, to throw or to wait for an abort. */
  /** Called when the read of the elements begins. */
  readonly onViewRead?: () => void;
  readonly viewProvider?: ModelProvider['complete'];
  /** The elements the stand-in of the gate reads for the view; two exportable ones when absent. */
  readonly viewNodes?: readonly ReturnType<typeof node>[];
  /** The elements the stand-in of the gate gives back for the references it is asked for; absent, `viewNodes` or the two exportable ones whatever is asked. */
  readonly readNodes?: (refs: ElementRefs, mask: boolean) => readonly ReturnType<typeof node>[];
  /** The relationships the stand-in of the gate gives back for the references it is asked for. */
  readonly readEdges?: (refs: ElementRefs) => readonly unknown[];
  /** The replies of the model to the step call; its presence turns the tool loop on. */
  readonly step?: FixtureReplies[string];
  /** The replies of the model to the answer call after tool steps. */
  readonly answer?: FixtureReplies[string];
  readonly loopSteps?: number;
  /** The deepagents turn runs on this chat model; every call it makes writes its audit event to the rig's sink. */
  readonly agent?: { readonly model: AgentChatModel; /** Called with the run of each agent turn after it ended. */ readonly onRun?: (run: AgentRun) => void; readonly maxCalls?: number; /** Only a test of the audit sets this, to an id an audit event cannot hold. */ readonly promptId?: string; /** The input limit of the agent alone, so that a test can pass the router and stop the agent. */ readonly maxInputTokens?: number; readonly removalFeedback?: NonNullable<Parameters<typeof createAgentTurn>[0]['removalFeedback']> };
  readonly loopRows?: number;
  /** The elements the source holds, as `type/id`, for the read of a source's elements that checks a written value; absent, every reference asked for is found. */
  readonly source?: readonly string[];
  /** The read of a source's elements leaves something out. */
  readonly sourceOmits?: boolean;
  /** The entity types of the source's mapping, in order, as the descriptions of the mapping give them; absent, the request has no descriptions. */
  readonly types?: readonly string[];
  /** Of those types, the ones whose identifiers are tokens the server made. */
  readonly keyed?: readonly string[];
  /** The title the source gives each element the lookup finds; absent, the type and the id. */
  readonly titles?: string;
}

export interface Rig {
  readonly route: ExtensionRoute;
  readonly events: AuditEvent[];
  readonly reads: string[];
  /** Ends the time of every turn at once. */
  expire(): void;
  /** The view answer alone, when `view` is given. */
  readonly view: ReturnType<typeof createViewAnswer> | undefined;
  readonly elementReads: { refs: unknown; mask: boolean; signal: AbortSignal | undefined }[];
  /** The reads of a source's elements that checked a written value. */
  readonly sourceReads: { refs: ElementRefs; mask: boolean }[];
  readonly runs: { asked: unknown; options: unknown; mask: boolean }[];
  readonly fixture: ReturnType<typeof createFixtureProvider>;
  readonly instructions: ReturnType<typeof buildAssistantInstructions>;
  readonly clock: { now: number };
  request(body?: unknown, over?: Partial<ExtensionRequest>): ExtensionRequest;
}

export async function rig(options: RigOptions = {}): Promise<Rig> {
  const folderPath = makeAskFolder([SOURCE], options.intents);
  writeFileSync(join(folderPath, SOURCE, 'classification.md'), CLASSIFICATION);
  const loaded = await loadAskFolder({ folder: folderPath, sourceIds: [SOURCE] });
  const folder = loaded.ok && options.noFolder !== true ? loaded.folder : undefined;
  const events: AuditEvent[] = [];
  const reads: string[] = [];
  const runs: Rig['runs'] = [];
  const elementReads: Rig['elementReads'] = [];
  const sourceReads: Rig['sourceReads'] = [];
  const clock = { now: NOW };
  const sink: AuditSink = { record: (event) => (options.sink === 'fails' ? Promise.reject(new Error('down')) : (events.push(event), Promise.resolve())) };
  const fixture = createFixtureProvider({ replies: { [replyKey(ROUTER_PROMPT_ID, ROUTER_PROMPT_VERSION)]: options.reply ?? ok('{"route":"view"}'), ...(options.view === undefined ? {} : { [replyKey(VIEW_PROMPT_ID, VIEW_PROMPT_VERSION)]: options.view }), ...(options.overview === undefined ? {} : { [replyKey(OVERVIEW_PROMPT_ID, OVERVIEW_PROMPT_VERSION)]: options.overview }) } });
  const provider: ModelProvider = options.viewProvider === undefined ? fixture : { complete: (request, signal) => (request.promptId === VIEW_PROMPT_ID && options.viewProvider !== undefined ? options.viewProvider(request, signal) : fixture.complete(request, signal)) };
  const model = createAuditedModelCall({ provider, configuration: { model: 'configured-model' }, sink });
  const expiry = new AbortController();
  const instructions = buildAssistantInstructions(PROMPT);
  const router = createAssistantRouter({ model, folder: () => folder, instructions: () => instructions, multiRead: () => options.step !== undefined && (options.loopSteps ?? 4) >= 2, maxInputTokens: () => options.maxInputTokens ?? 25_000, ...(options.routerMaxCalls === undefined ? {} : { maxCalls: () => options.routerMaxCalls ?? 1 }) });
  const viewInstructions = buildSummaryInstructions('You answer from the view. SENTINEL-VIEW-PROMPT', 'SENTINEL-TYPOLOGY');
  const viewAnswer = options.view === undefined ? undefined : createViewAnswer({ model, instructions: () => viewInstructions, checks: options.checks ?? createCheckRunner(), settings: () => ({ model: 'configured-model', maxInputTokens: options.viewMaxInputTokens ?? options.maxInputTokens ?? 25_000, maxCalls: options.maxCalls ?? 5, timeoutMs: 10_000, totalTimeoutMs: options.totalTimeoutMs ?? 180_000 }), now: () => clock.now });
  const overviewInstructions = buildSummaryInstructions('You describe the view. SENTINEL-OVERVIEW-PROMPT', '');
  const overviewAnswer = options.overview === undefined ? undefined : createViewAnswer({ model, prompt: { id: OVERVIEW_PROMPT_ID, version: OVERVIEW_PROMPT_VERSION, action: OVERVIEW_AUDIT_ACTION, connectionsOnly: true }, instructions: () => overviewInstructions, checks: options.checks ?? createCheckRunner(), settings: () => ({ model: 'configured-model', maxInputTokens: options.viewMaxInputTokens ?? options.maxInputTokens ?? 25_000, maxCalls: options.maxCalls ?? 5, timeoutMs: 10_000, totalTimeoutMs: options.totalTimeoutMs ?? 180_000 }), now: () => clock.now });
  const settings = readAssistantSettings(options.settingsEnv ?? {});
  const scripted = options.agent === undefined && options.step !== undefined ? { model: scriptedAgentModel(options) } : undefined;
  const agentOptions: RigOptions['agent'] = options.agent ?? scripted;
  const agentTurn =
    agentOptions === undefined
      ? undefined
      : createAgentTurn({
          model: (context, trace) => Promise.resolve(agentOptions === undefined ? undefined : auditChatModel(agentOptions.model, { recorder: createCallRecorder({ sink }), context, promptId: agentOptions.promptId ?? AGENT_PROMPT_ID, promptVersion: AGENT_PROMPT_VERSION, modelRef: 'configured-model', ...(trace === undefined ? {} : { trace }) })),
          modelRef: () => 'configured-model',
          instructions: () => buildSummaryInstructions('You answer from what was read. SENTINEL-AGENT-PROMPT', ''),
          settings: () => ({ maxCalls: agentOptions?.maxCalls ?? options.maxCalls ?? 8, maxSteps: options.loopSteps ?? 4, maxInputTokens: agentOptions?.maxInputTokens ?? options.maxInputTokens ?? 25_000, ...(options.loopRows === undefined ? {} : { rowsAllowed: options.loopRows }), timeoutMs: 10_000 }),
          checks: options.checks ?? createCheckRunner(),
          ...(agentOptions.removalFeedback === undefined ? {} : { removalFeedback: agentOptions.removalFeedback }),
          ...(agentOptions.onRun === undefined ? {} : { onRun: agentOptions.onRun }),
        });
  const route = createAssistantTurnRoute({ ...(agentTurn === undefined ? {} : { agentTurn: () => agentTurn }), ...(options.typology === undefined ? {} : { typology: () => options.typology }), ...(options.summaryKeys === undefined ? {} : { summaryKeys: () => options.summaryKeys }),  totalTimeoutMs: () => options.totalTimeoutMs ?? 180_000, turnDeadline: () => expiry.signal, ...(viewAnswer === undefined ? {} : { viewAnswer: () => viewAnswer, overview: () => overviewAnswer }), ...(options.pending === undefined ? {} : { pending: () => options.pending }), ...(options.runStore === undefined ? {} : { runs: () => options.runStore, runSettings: () => (settings.ok ? settings.settings : undefined) }), ...(options.threadStore === undefined ? {} : { threads: () => options.threadStore, contextTurns: () => (settings.ok ? settings.settings.contextTurns : undefined) }), ...(options.records === undefined ? {} : { records: () => options.records }), router: () => router, maxMessageWords: () => options.maxMessageWords ?? 1000, folder: () => folder, logger: () => (options.logs === undefined ? undefined : { warn: (fields, message) => void options.logs?.push({ fields, message }) }), now: () => clock.now });
  const request = (body: unknown = BODY, over: Partial<ExtensionRequest> = {}): ExtensionRequest => ({
    principalId: 'p-1',
    principalRole: 'investigator',
    previewOn: true,
    traceId: 'tr-1',
    audit: sink,
    askClassifier: { availability: () => ({ available: true }), classify: () => Promise.reject(new Error('the classifier is not used by the assistant')) },
    caseSummarizer: UNAVAILABLE_SUMMARIZER,
    signal: new AbortController().signal,
    signText: sign,
    askSourceReadable: async () => {
      reads.push('source');
      if (options.readable === 'source' || options.readable === 'both') throw new ExtensionRefusal({ code: 'NOT_FOUND' });
    },
    investigationReadable: async () => {
      reads.push('investigation');
      if (options.readable === 'investigation' || options.readable === 'both') throw new ExtensionRefusal({ code: 'NOT_FOUND' });
    },
    ...(options.patterns === undefined
      ? {}
      : {
          askPatterns: async () => ({ offers: options.patterns ?? [], cut: false }),
          askPatternFind: async (_sourceId: string, id: string) => options.patterns?.find((offer) => offer.id === id),
        }),
    readElements: async (scope, refs) => {
      elementReads.push({ refs, mask: scope.mask, signal: scope.signal });
      options.onViewRead?.();
      if (options.viewReadThrows !== undefined) throw options.viewReadThrows;
      if (options.viewReadHangs === true) return new Promise<never>(() => undefined);
      return { nodes: [...(options.readNodes?.(refs, scope.mask) ?? options.viewNodes ?? [node('A-1', options.viewTitle), node('A-2')])], edges: [...(options.readEdges?.(refs) ?? [])] as never, unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 };
    },
    readSourceElements: async (scope, refs) => {
      sourceReads.push({ refs, mask: scope.mask });
      const held = (ref: { entityType: string; stableId: string }): boolean => options.source === undefined || options.source.includes(`${ref.entityType}/${ref.stableId}`);
      return { nodes: refs.entities.filter(held).map((ref) => ({ ref: { sourceId: SOURCE, entityType: ref.entityType, stableId: ref.stableId }, display: { title: options.titles ?? `${ref.entityType} ${ref.stableId}`, type: ref.entityType }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } })), edges: [], unresolved: refs.entities.filter((ref) => !held(ref)).length, omitted: options.sourceOmits === true, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 };
    },
    ...(options.types === undefined ? {} : { typeDescriptions: () => ({ entityTypes: (options.types ?? []).map((type) => ({ type, label: type, displayName: type, ...(options.keyed?.includes(type) === true ? { keyed: true } : {}) })), relationshipTypes: [] }) }),
    askRunner: (scope) => ({
      run: async (asked, runOptions) => {
        runs.push({ asked, options: runOptions, mask: scope.mask });
        if (options.runThrows !== undefined) throw options.runThrows;
        return options.run === undefined ? { status: 'ok', result: okResult() } : options.run(runOptions?.continue === true, asked);
      },
    }),
    body,
    ...over,
  });
  return { route, expire: () => expiry.abort(), view: viewAnswer, events, reads, elementReads, sourceReads, runs, fixture, instructions, clock, request };
}

/** The text of a scripted reply: the reply itself or what a function of the request gives. */
const replyTextOf = (reply: FixtureReplies[string] | undefined, promptId: string): string | undefined => {
  const settled = typeof reply === 'function' ? reply({ promptId, version: 1, values: '' }) : reply;
  return settled?.kind === 'ok' ? settled.text : undefined;
};

const jsonOf = (text: string | undefined): Record<string, unknown> | undefined => {
  try {
    const data: unknown = JSON.parse(text ?? '');
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The agent a test script stands for: the router's `ask` reply is the first read, each reply of the step script a tool call (`{"done":true}` is the call of `answer` that the answer script gives, or the end of the turn
 * when there is none), and a reply that is neither ends the turn. The calls come from the old scripts, so a test written for the step call runs unchanged on the agent.
 */
function scriptedAgentModel(options: RigOptions): AgentChatModel {
  const model = fakeModel();
  let started = false;
  const next = (messages: readonly { readonly type: string; readonly name?: string }[]): AIMessage => {
    if (messages.some((message) => message.type === 'tool' && message.name === 'answer')) return new AIMessage('Done.');
    if (!started) {
      started = true;
      const routed = jsonOf(replyTextOf(options.reply, 'assistant.route'));
      if (routed?.['route'] === 'ask' && typeof routed['intent'] === 'string') {
        const entities = (routed['entities'] ?? {}) as Record<string, unknown>;
        const { pattern, ...rest } = entities;
        const saved = routed['intent'] === 'saved-pattern' && typeof pattern === 'string';
        return new AIMessage({ content: '', tool_calls: [{ name: saved ? pattern : routed['intent'], args: saved ? rest : entities, id: 'first', type: 'tool_call' }] });
      }
    }
    const text = replyTextOf(options.step, 'assistant.step');
    const step = jsonOf(text);
    if (step?.['done'] === true) {
      const answered = blocksOf(jsonOf(replyTextOf(options.answer, 'assistant.answer')));
      return answered === undefined ? new AIMessage('Done.') : new AIMessage({ content: '', tool_calls: [{ name: 'answer', args: answered, id: 'answer', type: 'tool_call' }] });
    }
    if (step !== undefined && typeof step['tool'] === 'string') return new AIMessage({ content: '', tool_calls: [{ name: step['tool'], args: (step['values'] ?? {}) as Record<string, unknown>, id: `step-${step['tool']}`, type: 'tool_call' }] });
    return new AIMessage(text ?? 'Done.');
  };
  for (let call = 0; call < 40; call += 1) model.respond((messages) => next(messages));
  return model;
}

export const nodeOf = node;

export const answerOf = async (promise: Promise<unknown>) => assistantTurnAnswerSchema.parse(await promise);

export const refusalOf = async (promise: Promise<unknown>): Promise<ExtensionRefusal | undefined> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExtensionRefusal) return error;
    throw error;
  }
  return undefined;
};

/** The reply a test script gives for `answer` in the shapes of the scripts ({sentences} or {columns, rows}), as the input of the tool: the blocks of one kind. */
function blocksOf(reply: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (reply === undefined || 'blocks' in reply) return reply;
  const { noDescription, ...rest } = reply;
  const extra = noDescription === undefined ? {} : { noDescription };
  if ('sentences' in rest) return { blocks: [{ kind: 'sentences', sentences: rest['sentences'] }], ...extra };
  if ('columns' in rest) return { blocks: [{ kind: 'table', columns: rest['columns'], rows: rest['rows'] }], ...extra };
  if (isTable(rest['table'])) return { blocks: [{ kind: 'table', columns: rest['table'].columns, rows: rest['table'].rows }], ...extra };
  return reply;
}

function isTable(value: unknown): value is { columns: unknown; rows: unknown } {
  return typeof value === 'object' && value !== null && 'columns' in value && 'rows' in value;
}
