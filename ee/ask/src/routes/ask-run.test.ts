import { parseExtensionRefusal, type AskPlanner, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { askRunRoute } from './ask-run.js';

const PLAN_ID = '0192f000-0000-7000-8000-0000000000a1';
const planner = (available: boolean): AskPlanner => ({ availability: () => (available ? { available } : { available, reason: 'not_in_this_edition' }), plan: () => Promise.reject(new Error('must not be called')) });

function requestWith(askPlanner: AskPlanner): ExtensionRequest {
  return { principalId: 'p', principalRole: 'investigator', previewOn: true, traceId: 'tr-1', audit: { record: async () => undefined }, askPlanner, body: { planId: PLAN_ID } };
}

describe('the Ask run route', () => {
  it('is a POST route with a request schema', () => {
    expect([askRunRoute.method, askRunRoute.url, askRunRoute.permission, askRunRoute.requestSchema === undefined]).toEqual(['POST', '/v1/ask/run', 'principal', false]);
  });

  it('refuses with ASK_UNSUPPORTED and the reason not-in-this-edition when the planner is not available', async () => {
    const thrown = await askRunRoute.handler(requestWith(planner(false))).catch((error: unknown) => error);
    expect(parseExtensionRefusal(thrown)).toEqual({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
  });

  it('refuses with NOT_FOUND for any plan while no plan is stored, when the planner is available', async () => {
    const thrown = await askRunRoute.handler(requestWith(planner(true))).catch((error: unknown) => error);
    expect(parseExtensionRefusal(thrown)).toEqual({ code: 'NOT_FOUND' });
  });
});
