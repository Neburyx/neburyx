import type { AiMappingView, AskPlan } from '@neburyx/contracts';
import { rebuildPlannerText } from '../allowlist/rebuild.js';
import { createAuditedModelCall } from '../audited.js';
import { PlannerCallFailed, catalogWords, createAskPlanner } from '../planner/index.js';
import { buildPromptRegistry } from '../prompts.js';
import type { ModelAnswer, ModelProvider, ModelRequest, PromptRecord } from '../provider.js';
import { createRequestBuilder } from '../request.js';
import { buildPropertyRules } from '../rules.js';
import { questionVocabulary } from '../vocabulary/vocabulary.js';

export interface ReplayEntry {
  readonly plan: string;
  readonly repair?: string;
  /** The model declined to answer: `plan` is empty, and the planner answers `model-refused`. */
  readonly refused?: true;
}

export type Replay = Readonly<Record<string, ReplayEntry>>;

export interface EvalPlannerOptions {
  readonly view: AiMappingView;
  readonly replay: Replay;
}

export type EvalAnswer =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'no-reply'; readonly call: 'plan' | 'repair' }
  | { readonly kind: 'answered'; readonly plan: AskPlan; readonly repaired: boolean };

export interface EvalPlanner {
  /** The text the planner is given for a wording, or undefined when the allowlist blocks it. */
  rebuild(wording: string): string | undefined;
  answer(wording: string): Promise<EvalAnswer>;
}

const PLACEHOLDER = /‹[A-Za-z0-9_-]+#[1-9][0-9]*›/g;
const EVAL_ACTOR = '00000000-0000-7000-8000-000000000000';
const EVAL_FAILURE = 'bad-reply';

export class EvalPlannerError extends Error {}

function spansOf(wording: string): readonly { readonly start: number; readonly end: number; readonly placeholder: string }[] {
  return [...wording.matchAll(PLACEHOLDER)].map((match) => ({ start: match.index, end: match.index + match[0].length, placeholder: match[0] }));
}

export interface PlannerOver {
  readonly planner: ReturnType<typeof createAskPlanner>;
  rebuild(wording: string): string | undefined;
}

/** The planner the real extension uses, over a provider the caller builds from the prompt registry (a replay, a counting recorder). */
export async function plannerOver(view: AiMappingView, makeProvider: (registry: Awaited<ReturnType<typeof buildPromptRegistry>> & { readonly ok: true }) => ModelProvider, model: string): Promise<PlannerOver> {
  const built = await buildPromptRegistry({});
  if (!built.ok) throw new EvalPlannerError('the built-in prompts could not be loaded');
  const { rules } = buildPropertyRules({}, undefined);
  if (rules === undefined) throw new EvalPlannerError('the property rules could not be built');
  const vocabulary = questionVocabulary({ view, catalogWords: catalogWords() });
  const audited = createAuditedModelCall({ provider: makeProvider(built), configuration: { registry: built.registry, model }, sink: { record: async () => undefined } });
  const planner = createAskPlanner({ model: audited, requestBuilder: createRequestBuilder(rules), view });
  return {
    planner,
    rebuild(wording) {
      const rebuilt = rebuildPlannerText({ text: wording, spans: spansOf(wording), vocabulary });
      return rebuilt.kind === 'rebuilt' ? rebuilt.text : undefined;
    },
  };
}

export { EVAL_ACTOR };

export interface ReplayState {
  missing: 'plan' | 'repair' | undefined;
  repaired: boolean;
}

/** The provider that answers from recorded replies, by the text of the question; a missing reply is noted in `state`, and a recorded refusal of the model answers as one. */
export function replayProvider(replay: Replay, registry: { resolve: (id: ModelRequest['promptId'], parameters: ModelRequest['parameters']) => { readonly record: PromptRecord } }, state: ReplayState = { missing: undefined, repaired: false }): ModelProvider {
  return {
    async complete(request: ModelRequest): Promise<ModelAnswer> {
      const { record } = registry.resolve(request.promptId, request.parameters);
      const entry = replay[String(request.parameters['question'])];
      const isRepair = request.promptId === 'ask.plan.repair';
      const text = isRepair ? entry?.repair : entry?.plan;
      if (isRepair) state.repaired = true;
      if (text === undefined) {
        state.missing = isRepair ? 'repair' : 'plan';
        return { status: 'failed', code: EVAL_FAILURE, prompt: record };
      }
      if (!isRepair && entry?.refused === true) return { status: 'refused', usage: { kind: 'unknown' }, prompt: record };
      return { status: 'ok', text, usage: { kind: 'unknown' }, model: 'replay', prompt: record };
    },
  };
}

/** The planner the real extension uses, answering from recorded replies; a question without its reply is reported, never skipped. */
export async function createEvalPlanner(options: EvalPlannerOptions): Promise<EvalPlanner> {
  const state: { missing: 'plan' | 'repair' | undefined; repaired: boolean } = { missing: undefined, repaired: false };
  const { planner, rebuild } = await plannerOver(options.view, (built) => replayProvider(options.replay, built.registry, state), 'replay');

  return {
    rebuild,
    async answer(wording) {
      const text = rebuild(wording);
      if (text === undefined) return { kind: 'blocked' };
      state.missing = undefined;
      state.repaired = false;
      try {
        const plan = await planner.plan({ text, context: { actorId: EVAL_ACTOR, actorRole: 'investigator', traceId: 'eval' } });
        return { kind: 'answered', plan, repaired: state.repaired };
      } catch (error) {
        if (error instanceof PlannerCallFailed && state.missing !== undefined) return { kind: 'no-reply', call: state.missing };
        throw error;
      }
    },
  };
}
