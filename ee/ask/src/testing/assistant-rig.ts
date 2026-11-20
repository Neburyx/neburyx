import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExtensionRefusal, askRunResultSchema, assistantTurnAnswerSchema, type AskPatternOffer, type ElementRefs, type AskRun, type AskRunResult, type AuditEvent, type AuditSink, type ExtensionRequest, type ExtensionRoute, type RecordQueue } from '@neburyx/contracts';
import { createAuditedModelCall, createCheckRunner, type CheckRunner, type ModelProvider } from '@neburyx/ee-ai-runtime';
import { createFixtureProvider, replyKey, type FixtureReply, type FixtureReplies } from '../../../ai-runtime/src/testing/fixture.js';
import { loadAskFolder } from '../folder/load.js';
import { buildAssistantInstructions } from '../assistant/instructions.js';
import { ROUTER_PROMPT_ID, ROUTER_PROMPT_VERSION, createAssistantRouter } from '../assistant/router.js';
import { createAssistantTurnRoute } from '../assistant/turn-route.js';
import { createToolLoop } from '../assistant/tool-loop.js';
import { createToolAnswer, ANSWER_PROMPT_ID, ANSWER_PROMPT_VERSION } from '../assistant/tool-answer.js';
import { STEP_PROMPT_ID, STEP_PROMPT_VERSION } from '../assistant/step-instructions.js';
import type { AssistantRunStore } from '../assistant/run-store.js';
import type { AssistantThreadStore } from '../assistant/thread-store.js';
import { readAssistantSettings } from '../assistant/settings.js';
import { VIEW_PROMPT_ID, VIEW_PROMPT_VERSION, VIEW_TOOLS_PROMPT_VERSION, createViewAnswer } from '../assistant/view-answer.js';
import { buildSummaryInstructions } from '../case-summary/instructions.js';
import { makeAskFolder } from './ask-folder.js';
import { UNAVAILABLE_SUMMARIZER } from './case-summarizer.js';

const SOURCE = 'demo';
const NOW = 1_800_000_000_000;
const CLASSIFICATION = 'Choose the intent that answers the question. SENTINEL-CLASSIFICATION';
const PROMPT = 'You route messages. SENTINEL-PROMPT';
export const MESSAGE = 'Which accounts share a device with SENTINEL-MESSAGE?';
export const VIEW_KEYS = [JSON.stringify(['node', SOURCE, 'widget', 'A-1']), JSON.stringify(['node', SOURCE, 'widget', 'A-2'])];
export const BODY = { sourceId: SOURCE, investigationId: 'inv-1', message: MESSAGE, viewElementKeys: ['n1', 'n2'] };
export const VIEW_BODY = { ...BODY, viewElementKeys: VIEW_KEYS };
export const sign = (text: string): string => createHmac('sha256', 'a-test-key').update(text).digest('hex');
export const ok = (text: string): FixtureReply => ({ kind: 'ok', text, usage: { kind: 'known', inputTokens: 20, outputTokens: 10 } });
export const routeAsk = (intent: string, entities: Record<string, string>): FixtureReply => ok(JSON.stringify({ route: 'ask', intent, entities }));

const node = (stableId: string, title = `Account ${stableId}`) => ({ ref: { sourceId: SOURCE, entityType: 'widget', stableId }, display: { title, type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
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
export const heavyResult = (): AskRunResult =>
  askRunResultSchema.parse({ templateId: 'shared-attribute', result: { status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', estimate: { quality: 'lowerBound', value: 1000, scope: 'test' }, threshold: 1000, continueLimit: 25, notices: [], warnings: [] } });
export const fileQueryResult = (): AskRunResult =>
  askRunResultSchema.parse({ templateId: 'file-query', result: { status: 'ok', intent: 'byId', count: { quality: 'exact', value: 2, scope: 'rows' }, nodes: [node('A-1'), node('A-2')], edges: [], notices: [], warnings: [] } });

export const offerOf = (id: string, name: string): AskPatternOffer => ({
  id,
  version: 3,
  name,
  projection: { kind: 'definition', anchorType: 'widget', startingEntity: 'held', steps: [{ relationshipTypes: ['link_a'], direction: 'out', arrivesAt: 'gadget', conditions: [], windowed: false }] },
});

export interface RigOptions {
  readonly reply?: FixtureReplies[string];
  readonly sink?: 'fails';
  readonly readable?: 'source' | 'investigation' | 'both';
  readonly maxInputTokens?: number;
  readonly maxMessageWords?: number;
  readonly maxCalls?: number;
  /** The calls of a turn the router may spend (it repeats a reply that is not a route when there is room); absent, it makes one call. */
  readonly routerMaxCalls?: number;
  /** The limit of the view answer alone; the router keeps its own. */
  readonly viewMaxInputTokens?: number;
  readonly totalTimeoutMs?: number;
  readonly patterns?: readonly AskPatternOffer[];
  readonly noFolder?: boolean;
  readonly intents?: unknown;
  readonly run?: (continuing: boolean) => AskRun | Promise<AskRun>;
  readonly runThrows?: Error;
  /** The store of the records of the turns' model calls; absent, nothing is recorded. */
  readonly runStore?: AssistantRunStore;
  /** The store of the threads, and the queue of the records its writes go through. */
  readonly threadStore?: AssistantThreadStore;
  readonly records?: RecordQueue;
  /** The environment the assistant's settings are read from for the run record. */
  readonly settingsEnv?: Record<string, string>;
  readonly logs?: { readonly fields: Record<string, unknown>; readonly message: string }[];
  /** The reply of the model to the view answer; its presence turns the view answer on, over the two elements `VIEW_KEYS` name. */
  readonly view?: FixtureReplies[string];
  readonly viewReadThrows?: Error;
  /** The read of the elements never settles, as a source that does not answer. */
  readonly viewReadHangs?: true;
  /** The title of the first element of the view. */
  readonly viewTitle?: string;
  readonly checks?: CheckRunner;
  /** Stands in for the model's service on the answer call, to throw or to wait for an abort. */
  /** Called when the read of the elements begins. */
  readonly onViewRead?: () => void;
  readonly viewProvider?: ModelProvider['complete'];
  /** The elements the stand-in of the gate reads for the view; two exportable ones when absent. */
  readonly viewNodes?: readonly ReturnType<typeof node>[];
  /** The elements the stand-in of the gate gives back for the references it is asked for; absent, `viewNodes` or the two exportable ones whatever is asked. */
  readonly readNodes?: (refs: ElementRefs, mask: boolean) => readonly ReturnType<typeof node>[];
  /** The replies of the model to the step call; its presence turns the tool loop on. */
  readonly step?: FixtureReplies[string];
  /** The replies of the model to the answer call after tool steps. */
  readonly answer?: FixtureReplies[string];
  readonly loopSteps?: number;
  readonly loopRows?: number;
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
  const clock = { now: NOW };
  const sink: AuditSink = { record: (event) => (options.sink === 'fails' ? Promise.reject(new Error('down')) : (events.push(event), Promise.resolve())) };
  const fixture = createFixtureProvider({ replies: { [replyKey(ROUTER_PROMPT_ID, ROUTER_PROMPT_VERSION)]: options.reply ?? ok('{"route":"view"}'), ...(options.view === undefined ? {} : { [replyKey(VIEW_PROMPT_ID, VIEW_PROMPT_VERSION)]: options.view, [replyKey(VIEW_PROMPT_ID, VIEW_TOOLS_PROMPT_VERSION)]: options.view }), ...(options.step === undefined ? {} : { [replyKey(STEP_PROMPT_ID, STEP_PROMPT_VERSION)]: options.step }), ...(options.answer === undefined ? {} : { [replyKey(ANSWER_PROMPT_ID, ANSWER_PROMPT_VERSION)]: options.answer }) } });
  const provider: ModelProvider = options.viewProvider === undefined ? fixture : { complete: (request, signal) => (request.promptId === VIEW_PROMPT_ID && options.viewProvider !== undefined ? options.viewProvider(request, signal) : fixture.complete(request, signal)) };
  const model = createAuditedModelCall({ provider, configuration: { model: 'configured-model' }, sink });
  const expiry = new AbortController();
  const instructions = buildAssistantInstructions(PROMPT);
  const router = createAssistantRouter({ model, folder: () => folder, instructions: () => instructions, multiRead: () => options.step !== undefined && (options.loopSteps ?? 4) >= 2, maxInputTokens: () => options.maxInputTokens ?? 25_000, ...(options.routerMaxCalls === undefined ? {} : { maxCalls: () => options.routerMaxCalls ?? 1 }) });
  const viewInstructions = buildSummaryInstructions('You answer from the view. SENTINEL-VIEW-PROMPT', 'SENTINEL-TYPOLOGY');
  const viewAnswer = options.view === undefined ? undefined : createViewAnswer({ model, instructions: () => viewInstructions, checks: options.checks ?? createCheckRunner(), settings: () => ({ model: 'configured-model', maxInputTokens: options.viewMaxInputTokens ?? options.maxInputTokens ?? 25_000, maxCalls: options.maxCalls ?? 5, timeoutMs: 10_000, totalTimeoutMs: options.totalTimeoutMs ?? 180_000 }), now: () => clock.now });
  const settings = readAssistantSettings(options.settingsEnv ?? {});
  const toolLoop = options.step === undefined ? undefined : createToolLoop({ model, prompt: () => PROMPT, settings: () => ({ maxCalls: options.maxCalls ?? 5, maxSteps: options.loopSteps ?? 4, maxInputTokens: options.maxInputTokens ?? 25_000, ...(options.loopRows === undefined ? {} : { rowsAllowed: options.loopRows }) }), answer: createToolAnswer({ model, instructions: () => buildSummaryInstructions('You answer from what the reads returned. SENTINEL-ANSWER-PROMPT', 'SENTINEL-TYPOLOGY'), checks: options.checks ?? createCheckRunner(), timeoutMs: 10_000, totalTimeoutMs: options.totalTimeoutMs ?? 180_000, now: () => clock.now }) });
  const route = createAssistantTurnRoute({ ...(toolLoop === undefined ? {} : { toolLoop: () => toolLoop, viewTools: () => (options.loopSteps ?? 4) >= 2 }), totalTimeoutMs: () => options.totalTimeoutMs ?? 180_000, turnDeadline: () => expiry.signal, ...(viewAnswer === undefined ? {} : { viewAnswer: () => viewAnswer }), ...(options.runStore === undefined ? {} : { runs: () => options.runStore, runSettings: () => (settings.ok ? settings.settings : undefined) }), ...(options.threadStore === undefined ? {} : { threads: () => options.threadStore, contextTurns: () => (settings.ok ? settings.settings.contextTurns : undefined) }), ...(options.records === undefined ? {} : { records: () => options.records }), router: () => router, maxMessageWords: () => options.maxMessageWords ?? 1000, folder: () => folder, logger: () => (options.logs === undefined ? undefined : { warn: (fields, message) => void options.logs?.push({ fields, message }) }), now: () => clock.now });
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
      return { nodes: [...(options.readNodes?.(refs, scope.mask) ?? options.viewNodes ?? [node('A-1', options.viewTitle), node('A-2')])], edges: [], unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 };
    },
    askRunner: (scope) => ({
      run: async (asked, runOptions) => {
        runs.push({ asked, options: runOptions, mask: scope.mask });
        if (options.runThrows !== undefined) throw options.runThrows;
        return options.run === undefined ? { status: 'ok', result: okResult() } : options.run(runOptions?.continue === true);
      },
    }),
    body,
    ...over,
  });
  return { route, expire: () => expiry.abort(), view: viewAnswer, events, reads, elementReads, runs, fixture, instructions, clock, request };
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
