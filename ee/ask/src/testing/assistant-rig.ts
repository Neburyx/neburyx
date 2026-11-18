import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExtensionRefusal, askRunResultSchema, assistantTurnAnswerSchema, type AskPatternOffer, type AskRun, type AskRunResult, type AuditEvent, type AuditSink, type ExtensionRequest, type ExtensionRoute } from '@neburyx/contracts';
import { createAuditedModelCall } from '@neburyx/ee-ai-runtime';
import { createFixtureProvider, replyKey, type FixtureReply } from '../../../ai-runtime/src/testing/fixture.js';
import { loadAskFolder } from '../folder/load.js';
import { buildAssistantInstructions } from '../assistant/instructions.js';
import { ROUTER_PROMPT_ID, ROUTER_PROMPT_VERSION, createAssistantRouter } from '../assistant/router.js';
import { createAssistantTurnRoute } from '../assistant/turn-route.js';
import type { AssistantRunStore } from '../assistant/run-store.js';
import { readAssistantSettings } from '../assistant/settings.js';
import { makeAskFolder } from './ask-folder.js';
import { UNAVAILABLE_SUMMARIZER } from './case-summarizer.js';

const SOURCE = 'demo';
const NOW = 1_800_000_000_000;
const CLASSIFICATION = 'Choose the intent that answers the question. SENTINEL-CLASSIFICATION';
const PROMPT = 'You route messages. SENTINEL-PROMPT';
export const MESSAGE = 'Which accounts share a device with SENTINEL-MESSAGE?';
export const BODY = { sourceId: SOURCE, investigationId: 'inv-1', message: MESSAGE, viewElementKeys: ['n1', 'n2'] };
export const sign = (text: string): string => createHmac('sha256', 'a-test-key').update(text).digest('hex');
export const ok = (text: string): FixtureReply => ({ kind: 'ok', text, usage: { kind: 'known', inputTokens: 20, outputTokens: 10 } });
export const routeAsk = (intent: string, entities: Record<string, string>): FixtureReply => ok(JSON.stringify({ route: 'ask', intent, entities }));

const node = (stableId: string) => ({ ref: { sourceId: SOURCE, entityType: 'widget', stableId }, display: { title: `Account ${stableId}`, type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
export const okResult = (): AskRunResult =>
  askRunResultSchema.parse({ templateId: 'shared-attribute', result: { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: { quality: 'exact', value: 1, scope: 'test' }, matchIds: [node('A-2').ref], nodes: [node('A-1'), node('A-2')], edges: [], notices: [], warnings: [] } });
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
  readonly reply?: FixtureReply;
  readonly sink?: 'fails';
  readonly readable?: 'source' | 'investigation' | 'both';
  readonly maxInputTokens?: number;
  readonly maxMessageWords?: number;
  readonly patterns?: readonly AskPatternOffer[];
  readonly noFolder?: boolean;
  readonly intents?: unknown;
  readonly run?: (continuing: boolean) => AskRun | Promise<AskRun>;
  readonly runThrows?: Error;
  /** The store of the records of the turns' model calls; absent, nothing is recorded. */
  readonly runStore?: AssistantRunStore;
  /** The environment the assistant's settings are read from for the run record. */
  readonly settingsEnv?: Record<string, string>;
  readonly logs?: { readonly fields: Record<string, unknown>; readonly message: string }[];
}

export interface Rig {
  readonly route: ExtensionRoute;
  readonly events: AuditEvent[];
  readonly reads: string[];
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
  const clock = { now: NOW };
  const sink: AuditSink = { record: (event) => (options.sink === 'fails' ? Promise.reject(new Error('down')) : (events.push(event), Promise.resolve())) };
  const fixture = createFixtureProvider({ replies: { [replyKey(ROUTER_PROMPT_ID, ROUTER_PROMPT_VERSION)]: options.reply ?? ok('{"route":"view"}') } });
  const model = createAuditedModelCall({ provider: fixture, configuration: { model: 'configured-model' }, sink });
  const instructions = buildAssistantInstructions(PROMPT);
  const router = createAssistantRouter({ model, folder: () => folder, instructions: () => instructions, maxInputTokens: () => options.maxInputTokens ?? 25_000 });
  const settings = readAssistantSettings(options.settingsEnv ?? {});
  const route = createAssistantTurnRoute({ ...(options.runStore === undefined ? {} : { runs: () => options.runStore, runSettings: () => (settings.ok ? settings.settings : undefined) }), router: () => router, maxMessageWords: () => options.maxMessageWords ?? 1000, folder: () => folder, logger: () => (options.logs === undefined ? undefined : { warn: (fields, message) => void options.logs?.push({ fields, message }) }), now: () => clock.now });
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
  return { route, events, reads, runs, fixture, instructions, clock, request };
}

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
