import type { AiMappingView, AskPlan } from '@neburyx/contracts';
import { rebuildPlannerText } from '../allowlist/rebuild.js';
import { createAuditedModelCall } from '../audited.js';
import { PlannerCallFailed, catalogWords, createAskPlanner } from '../planner/index.js';
import { buildPromptRegistry } from '../prompts.js';
import type { ModelAnswer, ModelProvider, ModelRequest } from '../provider.js';
import { createRequestBuilder } from '../request.js';
import { buildPropertyRules } from '../rules.js';
import { questionVocabulary } from '../vocabulary/vocabulary.js';

export interface ReplayEntry {
  readonly plan: string;
  readonly repair?: string;
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

/** The planner the real extension uses, answering from recorded replies; a question without its reply is reported, never skipped. */
export async function createEvalPlanner(options: EvalPlannerOptions): Promise<EvalPlanner> {
  const built = await buildPromptRegistry({});
  if (!built.ok) throw new EvalPlannerError('the built-in prompts could not be loaded');
  const { rules } = buildPropertyRules({}, undefined);
  if (rules === undefined) throw new EvalPlannerError('the property rules could not be built');
  const vocabulary = questionVocabulary({ view: options.view, catalogWords: catalogWords() });

  const state: { missing: 'plan' | 'repair' | undefined; repaired: boolean } = { missing: undefined, repaired: false };
  const provider: ModelProvider = {
    async complete(request: ModelRequest): Promise<ModelAnswer> {
      const { record } = built.registry.resolve(request.promptId, request.parameters);
      const entry = options.replay[String(request.parameters['question'])];
      const isRepair = request.promptId === 'ask.plan.repair';
      const text = isRepair ? entry?.repair : entry?.plan;
      if (isRepair) state.repaired = true;
      if (text === undefined) {
        state.missing = isRepair ? 'repair' : 'plan';
        return { status: 'failed', code: EVAL_FAILURE, prompt: record };
      }
      return { status: 'ok', text, usage: { kind: 'unknown' }, model: 'replay', prompt: record };
    },
  };
  const model = createAuditedModelCall({ provider, configuration: { registry: built.registry, model: 'replay' }, sink: { record: async () => undefined } });
  const planner = createAskPlanner({ model, requestBuilder: createRequestBuilder(rules), view: options.view });

  function rebuild(wording: string): string | undefined {
    const rebuilt = rebuildPlannerText({ text: wording, spans: spansOf(wording), vocabulary });
    return rebuilt.kind === 'rebuilt' ? rebuilt.text : undefined;
  }

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
