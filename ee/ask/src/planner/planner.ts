import type { AiMappingView, AskPlan, AskPlanContext, AskPlanner } from '@neburyx/contracts';
import type { AuditedModelCall } from '../audited.js';
import type { FailureCode, ModelAnswer } from '../provider.js';
import type { BuiltRequest, RequestBuilder } from '../request.js';
import { catalogText } from './catalog.js';
import { problemsOfPlan } from './check.js';
import { readReply } from './reply.js';
import { vocabularyText } from './vocabulary-text.js';

export const MODEL_REFUSED_REASON = 'model-refused';
export const INVALID_PLAN_REASON = 'invalid-plan';

/** A call to the model that did not answer: the code is the provider's, the call is already audited, and nothing of the call is in the error. */
export class PlannerCallFailed extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode) {
    super('the model call failed');
    this.name = 'PlannerCallFailed';
    this.code = code;
  }
}

export interface PlannerDeps {
  readonly model: AuditedModelCall;
  readonly requestBuilder: RequestBuilder;
  /** The mapping the extension was configured with: its names make the vocabulary. */
  readonly view?: AiMappingView | undefined;
}

const unsupported = (family: 'plan-not-usable' | 'model-refused', reason: string): AskPlan => ({ kind: 'unsupported', family, reason });

type Judged = { readonly kind: 'plan'; readonly plan: AskPlan } | { readonly kind: 'invalid'; readonly reply: string; readonly problems: readonly string[] } | { readonly kind: 'ended'; readonly plan: AskPlan };

/**
 * The planner: the previewed text, the catalog and the vocabulary go to the model through the audited call, and the reply is read as a plan and checked. A reply that cannot be used gets one repair call, with the problems by path, and then the plan is unsupported.
 * The provider's own deadline governs each call.
 */
export function createAskPlanner(deps: PlannerDeps): AskPlanner {
  const catalog = catalogText();
  const vocabulary = vocabularyText(deps.view);

  async function ask(built: BuiltRequest, context: AskPlanContext): Promise<ModelAnswer> {
    return deps.model.call(
      built.request,
      {
        actorId: context.actorId,
        actorRole: context.actorRole,
        traceId: context.traceId,
        ...(context.investigationId === undefined ? {} : { investigationId: context.investigationId }),
        ...(context.sourceId === undefined ? {} : { sourceId: context.sourceId }),
        ...(built.sentPii.length === 0 ? {} : { piiPropertiesSent: built.sentPii }),
      },
      new AbortController().signal,
    );
  }

  function judge(answer: ModelAnswer, text: string): Judged {
    switch (answer.status) {
      case 'refused':
        return { kind: 'ended', plan: unsupported('model-refused', MODEL_REFUSED_REASON) };
      case 'failed':
        throw new PlannerCallFailed(answer.code);
      case 'ok': {
        const reading = readReply(answer.text);
        const problems = reading.ok ? problemsOfPlan(reading.plan, { text, view: deps.view }) : reading.problems;
        if (reading.ok && problems.length === 0) return { kind: 'plan', plan: reading.plan };
        return { kind: 'invalid', reply: answer.text, problems };
      }
      default: {
        const unreachable: never = answer;
        return unreachable;
      }
    }
  }

  return {
    availability: () => ({ available: true }),
    async plan({ text, context }) {
      const first = judge(await ask(deps.requestBuilder.ask({ question: text, catalog, vocabulary }), context), text);
      if (first.kind !== 'invalid') return first.plan;
      const repaired = judge(await ask(deps.requestBuilder.askRepair({ question: text, catalog, vocabulary, reply: first.reply, problems: first.problems.join('\n') }), context), text);
      return repaired.kind === 'invalid' ? unsupported('plan-not-usable', INVALID_PLAN_REASON) : repaired.plan;
    },
  };
}
