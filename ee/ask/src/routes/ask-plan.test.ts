import { parseExtensionRefusal, type AskPlan, type AskPlanner, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { askPlanRoute } from './ask-plan.js';

const UNAVAILABLE: AskPlanner = { availability: () => ({ available: false, reason: 'not_in_this_edition' }), plan: () => Promise.reject(new Error('must not be called')) };

function requestWith(askPlanner: AskPlanner, body: unknown = { message: 'Who shares a device?' }): ExtensionRequest {
  return { principalId: 'p', principalRole: 'investigator', previewOn: true, traceId: 'tr-1', audit: { record: async () => undefined }, askPlanner, body };
}

describe('the Ask plan route', () => {
  it('is a POST route with a request schema', () => {
    expect([askPlanRoute.method, askPlanRoute.url, askPlanRoute.permission, askPlanRoute.requestSchema === undefined]).toEqual(['POST', '/v1/ask/plan', 'principal', false]);
  });

  it('refuses with ASK_UNSUPPORTED and the reason not-in-this-edition, and never calls the planning operation, when the planner is not available', async () => {
    let planned = 0;
    const planner: AskPlanner = { ...UNAVAILABLE, plan: () => (planned++, Promise.reject(new Error('must not be called'))) };
    const thrown = await askPlanRoute.handler(requestWith(planner)).catch((error: unknown) => error);
    expect(parseExtensionRefusal(thrown)).toEqual({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
    expect(planned).toBe(0);
  });

  it('passes the message to an available planner', async () => {
    const seen: string[] = [];
    const plan: AskPlan = { kind: 'unsupported', reason: 'No template fits.' };
    const planner: AskPlanner = { availability: () => ({ available: true }), plan: async ({ text }) => (seen.push(text), plan) };
    expect(await askPlanRoute.handler(requestWith(planner))).toEqual({ plan });
    expect(seen).toEqual(['Who shares a device?']);
  });
});
