import { askEditRequestSchema, askEditResponseSchema, askPlanSchema, ExtensionRefusal, type AiMappingView, type ExtensionRoute } from '@neburyx/contracts';
import { CATALOG } from '../planner/catalog.js';
import { problemsOfPlan } from '../planner/check.js';
import { editedParams } from '../plans/edit-params.js';
import type { PlanStore } from '../plans/index.js';
import { refusalOfPlan } from '../plans/refusals.js';

export const ASK_EDIT_URL = '/v1/ask/edit';

/** The rationale an edited plan carries: the plan's own words are not kept, and what an investigator changed is theirs. */
export const EDITED_RATIONALE = 'Edited by the investigator.';

export interface AskEditRouteOptions {
  /** The store of plans, asked each time because the application builds it after the route is made. */
  readonly plans?: () => PlanStore | undefined;
  /** The mapping's view, asked each time for the same reason; the edited parameters must name types and rules that it holds. */
  readonly view?: () => AiMappingView | undefined;
}

const unsupported = (): ExtensionRefusal => new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
const invalid = (): ExtensionRefusal => new ExtensionRefusal({ code: 'ASK_PLAN_INVALID' });

/**
 * Changes the parameters of a proposed plan of the caller: the new plan is stored with the old one as its parent and the old one is cancelled, together or not at all. The parameters pass the same
 * schema and vocabulary checks as a plan the model made, the template is the plan's own, and a reference of another source than the plan's is refused.
 */
export function createAskEditRoute(options: AskEditRouteOptions = {}): ExtensionRoute {
  const plansOf = options.plans ?? (() => undefined);
  const viewOf = options.view ?? (() => undefined);
  return {
    method: 'POST',
    url: ASK_EDIT_URL,
    permission: 'principal',
    requestSchema: askEditRequestSchema,
    responseSchema: askEditResponseSchema,
    async handler(request) {
      if (!request.askPlanner.availability().available) throw unsupported();
      const plans = plansOf();
      if (plans === undefined) throw unsupported();
      const body = askEditRequestSchema.parse(request.body);
      const current = await plans.get(body.planId, request.principalId);
      if (current === undefined) throw refusalOfPlan('absent');
      if (current.state !== 'proposed') throw refusalOfPlan(current.state === 'expired' ? 'expired' : 'not-runnable');
      if (body.templateId !== current.templateId) throw invalid();
      const entry = CATALOG.find((candidate) => candidate.id === body.templateId);
      if (entry === undefined) throw invalid();
      const edited = editedParams(body.templateId, body.params, current.sourceId);
      if (edited.status === 'other-source') throw new ExtensionRefusal({ code: 'SOURCE_MISMATCH' });
      if (edited.status === 'invalid') throw invalid();
      const candidate = askPlanSchema.safeParse({ kind: 'plan', templateId: body.templateId, templateVersion: entry.version, rationale: EDITED_RATIONALE, params: edited.params });
      if (!candidate.success || candidate.data.kind !== 'plan') throw invalid();
      if (problemsOfPlan(candidate.data, { text: '', view: viewOf(), mode: 'references' }).length > 0) throw invalid();
      const result = await plans.edit({ planId: body.planId, userId: request.principalId, templateId: body.templateId, templateVersion: entry.version, params: candidate.data.params });
      if (result.status !== 'edited') throw refusalOfPlan(result.status);
      return { plan: candidate.data, planId: result.plan.id, expiresAt: result.plan.expiresAt.toISOString() };
    },
  };
}

export const askEditRoute = createAskEditRoute();
