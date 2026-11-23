import { askRunResultSchema, assistantTurnAnswerSchema, type AuditSink, type ExtensionRequest } from '@neburyx/contracts';
import { createAuditedModelCall, createCheckRunner, type ModelProvider } from '@neburyx/ee-ai-runtime';
import { createAssistantRouter } from '../assistant/router.js';
import { createAssistantTurnRoute } from '../assistant/turn-route.js';
import { createViewAnswer } from '../assistant/view-answer.js';
import { loadAssistantInstructions } from '../assistant/load-instructions.js';
import { loadViewInstructions } from '../assistant/view-instructions.js';
import { readAssistantSettings } from '../assistant/settings.js';
import type { LoadedSource } from './evaluate.js';

/** One call of the model during a turn: which prompt it was, its tokens (when the provider counted them) and how long it took. */
interface CallSeen {
  readonly promptId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly ms: number;
}

/** What one message cost on the real assistant turn: the model calls by prompt, the tokens, the time, and the route the turn took. */
export interface LoopCostRun {
  readonly route: string;
  readonly calls: Readonly<Record<string, number>>;
  readonly total: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly ms: number;
  /** The reads the turn made, as the answer reports them (a read from the router's own intent counts as one): what the steps limit bounds. */
  readonly steps: number;
  /** The largest input and the largest output of a single call of the turn: what the token limits apply to. */
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  /** The rows the turn's read returned, when the turn read for an ask. */
  readonly rows: number;
}

export interface LoopCostInput {
  readonly message: string;
  readonly viewElementKeys: readonly string[];
}

const ACTOR = '00000000-0000-7000-8000-000000000001';
const INVESTIGATION = '00000000-0000-7000-8000-0000000000a1';
const NOTHING: AuditSink = { record: async () => undefined };

/** The stand-in for what a read of an intent returns: the same fixed result for every intent, of one element and no relationship. Rows, steps and read times it gives are not representative of a source. */
function fixedResult(sourceId: string) {
  const node = { ref: { sourceId, entityType: 'item', stableId: 'S-1' }, display: { title: 'Item S-1', type: 'item' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
  return askRunResultSchema.parse({ templateId: 'shared-attribute', result: { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: { quality: 'exact', value: 1, scope: 'stand-in' }, matchIds: [node.ref], nodes: [node], edges: [], notices: [], warnings: [] } });
}

/** The stand-in for the gate's read of the elements in view: each reads back titled by its stable id. */
function viewNodes(refs: { readonly entities: readonly { readonly sourceId: string; readonly entityType: string; readonly stableId: string }[] }) {
  return refs.entities.map((ref) => ({ ref, display: { title: ref.stableId, type: ref.entityType }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } }));
}

/**
 * Runs one message through the real assistant turn route built as the product builds it, over a stand-in for the capabilities (a fixed result for each intent of the folder and for the view read) and the given provider, with the
 * steps setting at the given number (the router's and the view call's model calls only: the agent turn is measured by the evaluation of the agent, not here). The registry the turn offers is the folder's intents, the built-in templates and the view read, each answered with the fixed result; patterns are not offered. Reads nothing from a source.
 */
export async function loopCostRun(source: LoadedSource, provider: ModelProvider, model: string, input: LoopCostInput, steps: number): Promise<LoopCostRun> {
  const read = readAssistantSettings({ NEBURYX_ASSISTANT_MAX_STEPS: String(steps) });
  if (!read.ok) throw new Error('the settings of the assistant could not be read');
  const settings = read.settings;
  const prompt = await loadAssistantInstructions();
  const view = await loadViewInstructions();
  if (!prompt.ok || !view.ok) throw new Error('the instructions of the assistant could not be read');
  const seen: CallSeen[] = [];
  const counting: ModelProvider = {
    async complete(request, signal) {
      const started = Date.now();
      const answer = await provider.complete(request, signal);
      const usage = answer.usage;
      const tokens = usage !== undefined && usage.kind === 'known' ? usage : undefined;
      seen.push({ promptId: request.promptId, inputTokens: tokens?.inputTokens ?? 0, outputTokens: tokens?.outputTokens ?? 0, ms: Date.now() - started });
      return answer;
    },
  };
  const call = createAuditedModelCall({ provider: counting, configuration: { model }, sink: NOTHING });
  const checks = createCheckRunner();
  const router = createAssistantRouter({ model: call, folder: () => source.folder, instructions: () => prompt.instructions, multiRead: () => settings.maxSteps >= 2, maxInputTokens: () => settings.maxInputTokens, maxCalls: () => settings.maxCalls });
  const viewAnswer = createViewAnswer({ model: call, instructions: () => view.instructionsFor(source.folder.source(source.sourceId)?.typology?.text ?? ''), checks, settings: () => ({ model: settings.model, maxInputTokens: settings.maxInputTokens, maxCalls: settings.maxCalls, timeoutMs: settings.timeoutMs, totalTimeoutMs: settings.totalTimeoutMs }) });
  const route = createAssistantTurnRoute({ router: () => router, totalTimeoutMs: () => settings.totalTimeoutMs, contextTurns: () => settings.contextTurns, viewAnswer: () => viewAnswer, maxMessageWords: () => settings.maxMessageWords, folder: () => source.folder, logger: () => undefined });
  const body = { sourceId: source.sourceId, investigationId: INVESTIGATION, message: input.message, viewElementKeys: [...input.viewElementKeys] };
  const request: ExtensionRequest = {
    principalId: ACTOR,
    principalRole: 'investigator',
    previewOn: true,
    traceId: 'loop-cost',
    audit: NOTHING,
    askClassifier: { availability: () => ({ available: true }), classify: () => Promise.reject(new Error('the classifier is not used by the assistant')) },
    caseSummarizer: { maxElements: 300, availability: () => ({ available: false, reason: 'not used' }), summarize: () => Promise.reject(new Error('not used')) },
    signal: new AbortController().signal,
    signText: (text: string) => `stand-in:${text.length}`,
    askSourceReadable: async () => undefined,
    investigationReadable: async () => undefined,
    readElements: async (_scope: unknown, refs: { readonly entities: readonly { readonly sourceId: string; readonly entityType: string; readonly stableId: string }[] }) => ({ nodes: viewNodes(refs), edges: [], unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 }) as never,
    askRunner: () => ({ run: async () => ({ status: 'ok', result: fixedResult(source.sourceId) }) }),
    body,
  } as unknown as ExtensionRequest;
  const started = Date.now();
  const raw = await route.handler(request);
  const answer = assistantTurnAnswerSchema.parse(raw);
  const ms = Date.now() - started;
  const calls: Record<string, number> = {};
  for (const entry of seen) calls[entry.promptId] = (calls[entry.promptId] ?? 0) + 1;
  const where = answer.status === 'answered' ? `answered ${answer.route}` : answer.status;
  const rows = answer.status === 'answered' && answer.route === 'ask' ? ((raw as { readonly step?: { readonly rows?: number } }).step?.rows ?? 0) : 0;
  const reported = raw as { readonly steps?: number; readonly step?: unknown };
  const reads = reported.steps ?? (reported.step === undefined ? 0 : 1);
  return { route: where, calls, total: seen.length, steps: reads, maxInputTokens: Math.max(0, ...seen.map((entry) => entry.inputTokens)), maxOutputTokens: Math.max(0, ...seen.map((entry) => entry.outputTokens)), rows, inputTokens: seen.reduce((sum, entry) => sum + entry.inputTokens, 0), outputTokens: seen.reduce((sum, entry) => sum + entry.outputTokens, 0), ms };
}

/** The tool steps a turn may take by default and the model calls it may make: the settings of the assistant as a run with no setting given has them. */
export function loopDefaults(): { readonly steps: number; readonly maxCalls: number } {
  const read = readAssistantSettings({});
  if (!read.ok) throw new Error('the default settings of the assistant could not be read');
  return { steps: read.settings.maxSteps, maxCalls: read.settings.maxCalls };
}
