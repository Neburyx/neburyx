import { askRunRequestSchema, askRunResponseSchema, ExtensionRefusal, type ExtensionRoute } from '@neburyx/contracts';

export const ASK_RUN_URL = '/v1/ask/run';

export const askRunRoute: ExtensionRoute = {
  method: 'POST',
  url: ASK_RUN_URL,
  permission: 'principal',
  requestSchema: askRunRequestSchema,
  responseSchema: askRunResponseSchema,
  async handler(request) {
    if (!request.askPlanner.availability().available) throw new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
    throw new ExtensionRefusal({ code: 'NOT_FOUND' });
  },
};
