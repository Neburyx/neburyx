import { createAuditedModelCall, promptRecordOf, type ModelProvider } from '@neburyx/ee-ai-runtime';
import { readViewKeys, type AssistantRouterReply, type ElementRefs, type SummaryReading } from '@neburyx/contracts';
import { buildContext, withView, type TurnContext } from '../assistant/context.js';
import { selectedKeysOf } from '../assistant/selection.js';
import { candidatesOfReply, roleEntityType } from '../assistant/clarification.js';
import type { AssistantContextTurn } from '../assistant/thread-store.js';
import { createAssistantRouter, type RouterOutcome } from '../assistant/router.js';
import { buildAssistantInstructions } from '../assistant/instructions.js';
import { loadAssistantInstructions } from '../assistant/load-instructions.js';
import { THREAD_READ_TURNS_CEILING, THREAD_READ_TURNS_DEFAULT } from '@neburyx/contracts';
import { DEFAULTS, RANGES, readAssistantSettings } from '../assistant/settings.js';
import type { LoadedSource } from './evaluate.js';


/** An earlier turn of a thread as its labels give it: the route it took, and for a plan its intent and the values it ran for each role. */
interface LabelledTurn {
  readonly route: 'view' | 'ask' | 'refuse';
  readonly intent?: string;
  readonly entities?: Readonly<Record<string, string>>;
  readonly cause?: string;
  readonly cited?: readonly { readonly entityType: string; readonly stableId: string }[];
}

export interface RouteInput {
  readonly message: string;
  readonly viewElementKeys: readonly string[];
  /** The keys of the elements the person selected on the canvas, as the panel sends them; the product's own code drops those that are not in the view. */
  readonly selectionKeys?: readonly string[];
  readonly earlier?: readonly LabelledTurn[];
}

/** What the router gave for one message, and the stable id each key of the thread's context stood for in it. */
export type RouteResult = RouterOutcome & { readonly keys: Readonly<Record<string, string>> };

const ACTOR = '00000000-0000-7000-8000-000000000001';
const INVESTIGATION = '00000000-0000-7000-8000-0000000000a1';

/** The assistant's settings as a run of the product with no setting given has them. */
function productSettings() {
  const read = readAssistantSettings({});
  if (!read.ok) throw new Error('the default settings of the assistant could not be read');
  return read.settings;
}

async function shippedPrompt(): Promise<string> {
  const loaded = await loadAssistantInstructions();
  if (!loaded.ok) throw new Error('the shipped prompt of the router could not be read');
  return loaded.instructions.prompt;
}

/** The stand-in for the gate's read of the context's elements: each reads back titled by its stable id (the product shows the display title). No source is read. */
async function standIn(refs: ElementRefs): Promise<SummaryReading> {
  return { nodes: refs.entities.map((ref) => ({ ref, display: { title: ref.stableId, type: ref.entityType }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } })), edges: [], unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 } as never;
}

function contextTurnOf(source: LoadedSource, turn: LabelledTurn): AssistantContextTurn {
  const intent = turn.intent === undefined ? undefined : source.folder.intent(source.sourceId, turn.intent);
  const entities = Object.entries(turn.entities ?? {}).flatMap(([role, stableId]) => {
    const entityType = intent === undefined ? undefined : roleEntityType(intent, role);
    return entityType === undefined ? [] : [{ role, ref: { sourceId: source.sourceId, entityType, stableId } }];
  });
  return { route: turn.route, outcome: turn.route === 'refuse' ? 'refused' : 'answered', ...(turn.cause === undefined ? {} : { cause: turn.cause }), ...(turn.intent === undefined ? {} : { intent: turn.intent }), entities, citationRefs: (turn.cited ?? []).map((element) => ({ sourceId: source.sourceId, entityType: element.entityType, stableId: element.stableId })) };
}

/** The context the product's own builder makes from the labelled earlier turns: at most the last turns the setting names, never the model's replies. */
async function contextOf(source: LoadedSource, earlier: readonly LabelledTurn[] | undefined): Promise<TurnContext | undefined> {
  const turns = (earlier ?? []).slice(-productSettings().contextTurns).map((turn) => contextTurnOf(source, turn));
  return buildContext({ turns, sourceId: source.sourceId, read: standIn });
}

/** The router built as the product builds it: the settings' calls, the steps that decide the reply format, the shipped prompt and the source's classification text. */
async function routerOf(source: LoadedSource, provider: ModelProvider, model: string) {
  const settings = productSettings();
  const prompt = await shippedPrompt();
  const call = createAuditedModelCall({ provider, configuration: { model }, sink: { record: async () => undefined } });
  return createAssistantRouter({
    model: call,
    folder: () => source.folder,
    instructions: () => buildAssistantInstructions(prompt),
    maxInputTokens: () => settings.maxInputTokens,
    maxCalls: () => settings.maxCalls,
    multiRead: () => settings.maxSteps >= 2,
  });
}

/** Routes one message through the product's own router over the given provider: the audited call, the instructions, the strict reply reader and the single repeat with the fixed note. */
export async function routeMessage(source: LoadedSource, provider: ModelProvider, model: string, input: RouteInput): Promise<RouteResult> {
  const route = await routerOf(source, provider, model);
  const thread = await contextOf(source, input.earlier);
  // the elements in view get keys of the table of the thread's context, as the product's turn gives them
  const view = readViewKeys(input.viewElementKeys, source.sourceId);
  const selectedKeys = view.ok ? selectedKeysOf(input.viewElementKeys, input.selectionKeys) : [];
  const selected = selectedKeys.length === 0 ? undefined : readViewKeys(selectedKeys, source.sourceId);
  const context = withView(thread, view.ok ? view.refs : { entities: [], edges: [], aggregates: [], derived: [] }, source.sourceId, selected?.ok === true ? selected.refs : undefined);
  const accepts = (reply: AssistantRouterReply): boolean => reply.route !== 'clarify' || candidatesOfReply(reply, context, source.folder, source.sourceId) !== undefined;
  const outcome = await route({ sourceId: source.sourceId, investigationId: INVESTIGATION, message: input.message, viewElementKeys: input.viewElementKeys, ...(context.viewText === undefined ? {} : { viewText: context.viewText }), actorId: ACTOR, actorRole: 'investigator', traceId: 'route-eval', ...(thread === undefined ? {} : { context: thread.text }), accepts }, new AbortController().signal);
  return { ...outcome, keys: Object.fromEntries([...context.keys].map(([key, ref]) => [key, ref.stableId])) };
}

/** The key the thread's context gives each element of the labelled earlier turns and then each element in view, with the stable id it stands for: what a scripted reply names its elements by. */
export async function contextKeys(source: LoadedSource, earlier: readonly LabelledTurn[], viewElementKeys: readonly string[] = []): Promise<Readonly<Record<string, string>>> {
  const thread = await contextOf(source, earlier);
  // the elements in view get keys after those of the thread, as the product's turn gives them
  const view = readViewKeys(viewElementKeys, source.sourceId);
  const context = withView(thread, view.ok ? view.refs : { entities: [], edges: [], aggregates: [], derived: [] }, source.sourceId);
  return Object.fromEntries([...context.keys].map(([key, ref]) => [key, ref.stableId]));
}

/** The number of turns of a thread the router is shown: the setting of the assistant. */
export function contextTurns(): number {
  return productSettings().contextTurns;
}

/** The values of the two requests a message can make, the first and the repeat after a reply that is not a route, as the router builds them: found by running the router over a provider that records them. */
export async function routerRequests(source: LoadedSource, input: RouteInput): Promise<{ readonly first: string; readonly repeat: string }> {
  const seen: string[] = [];
  const notARoute: ModelProvider = {
    async complete(request) {
      seen.push(request.values);
      return { status: 'ok', text: '{"route":', usage: { kind: 'unknown' }, model: 'probe', prompt: promptRecordOf(request) };
    },
  };
  await routeMessage(source, notARoute, 'probe', input);
  const [first, repeat] = seen;
  if (first === undefined || repeat === undefined) throw new Error('the router made no repeat request');
  return { first, repeat };
}

/** The SHA-256 of the instruction text the router sends for a source: its prompt, the source's classification text and the reply format, so that a replay made for other text is refused. */
export async function routerTextSha256(source: LoadedSource): Promise<string> {
  const settings = productSettings();
  const found = source.folder.source(source.sourceId);
  if (found === undefined) throw new Error('the source is not in its folder');
  const prompt = await shippedPrompt();
  return buildAssistantInstructions(`${prompt}\n\n# This source's questions\n\n${found.classification.text}`, settings.maxSteps >= 2).sha256;
}

/** The size in bytes of the instruction text the router sends for a source, which a dry run needs to estimate the input of a run. */
export async function routerTextBytes(source: LoadedSource): Promise<number> {
  const settings = productSettings();
  const found = source.folder.source(source.sourceId);
  if (found === undefined) throw new Error('the source is not in its folder');
  const prompt = await shippedPrompt();
  return Buffer.byteLength(buildAssistantInstructions(`${prompt}\n\n# This source's questions\n\n${found.classification.text}`, settings.maxSteps >= 2).text, 'utf8');
}

/** The limits of a turn as the settings of the assistant have them: the default a turn runs under and the highest value the setting accepts. */
export function assistantLimits(): Readonly<Record<'steps' | 'calls' | 'inputTokens' | 'outputTokens' | 'words' | 'threadRead', { readonly default: number; readonly highest: number }>> {
  return {
    steps: { default: DEFAULTS.maxSteps, highest: RANGES.maxSteps.max },
    calls: { default: DEFAULTS.maxCalls, highest: RANGES.maxCalls.max },
    inputTokens: { default: DEFAULTS.maxInputTokens, highest: RANGES.maxInputTokens.max },
    outputTokens: { default: DEFAULTS.maxOutputTokens, highest: RANGES.maxOutputTokens.max },
    words: { default: DEFAULTS.maxMessageWords, highest: RANGES.maxMessageWords.max },
    threadRead: { default: THREAD_READ_TURNS_DEFAULT, highest: THREAD_READ_TURNS_CEILING },
  };
}
