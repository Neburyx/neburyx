import { askPlanRequestSchema, askPlanResponseSchema, ExtensionRefusal, type ExtensionRoute } from '@neburyx/contracts';

export const ASK_PLAN_URL = '/v1/ask/plan';

export const askPlanRoute: ExtensionRoute = {
  method: 'POST',
  url: ASK_PLAN_URL,
  permission: 'principal',
  requestSchema: askPlanRequestSchema,
  responseSchema: askPlanResponseSchema,
  async handler(request) {
    if (!request.askPlanner.availability().available) throw new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
    const { message } = askPlanRequestSchema.parse(request.body);
    return { plan: await request.askPlanner.plan({ text: message }) };
  },
};
