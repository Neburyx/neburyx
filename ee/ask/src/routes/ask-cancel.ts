import { askCancelRequestSchema, askCancelResponseSchema, ExtensionRefusal, type ExtensionRoute } from '@neburyx/contracts';
import type { PlanStore } from '../plans/index.js';
import { refusalOfPlan } from '../plans/refusals.js';

export const ASK_CANCEL_URL = '/v1/ask/cancel';

export interface AskCancelRouteOptions {
  /** The store of plans, asked each time because the application builds it after the route is made. */
  readonly plans?: () => PlanStore | undefined;
}

/** Drops a proposed plan of the caller. A plan that is not theirs, not there, past its time or no longer proposed is refused as every call on a plan refuses it. */
export function createAskCancelRoute(options: AskCancelRouteOptions = {}): ExtensionRoute {
  const plansOf = options.plans ?? (() => undefined);
  return {
    method: 'POST',
    url: ASK_CANCEL_URL,
    permission: 'principal',
    requestSchema: askCancelRequestSchema,
    responseSchema: askCancelResponseSchema,
    async handler(request) {
      if (!request.askPlanner.availability().available) throw new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
      const plans = plansOf();
      if (plans === undefined) throw new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
      const body = askCancelRequestSchema.parse(request.body);
      const result = await plans.cancel(body.planId, request.principalId);
      if (result.status !== 'cancelled') throw refusalOfPlan(result.status);
      return { planId: body.planId, state: 'cancelled' as const };
    },
  };
}

export const askCancelRoute = createAskCancelRoute();
