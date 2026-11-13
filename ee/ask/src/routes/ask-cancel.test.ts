import { parseExtensionRefusal, type AskPlanner, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createMemoryPlanStore } from '../testing/memory-plans.js';
import { ASK_CANCEL_URL, createAskCancelRoute } from './ask-cancel.js';

const available: AskPlanner = { availability: () => ({ available: true }), plan: () => Promise.reject(new Error('not used')) };
const request = (body: unknown, over: Partial<ExtensionRequest> = {}): ExtensionRequest => ({ principalId: 'u-1', principalRole: 'investigator', previewOn: true, traceId: 'tr-1', audit: { record: async () => undefined }, askPlanner: available, body, ...over });
const refusalOf = async (promise: Promise<unknown>) => parseExtensionRefusal(await promise.catch((error: unknown) => error));

async function setup() {
  const plans = createMemoryPlanStore();
  const stored = await plans.insert({ userId: 'u-1', sourceId: 'demo', templateId: 'entity', templateVersion: 1, params: {}, planningTraceId: 'tr-0' });
  const route = createAskCancelRoute({ plans: () => plans });
  return { plans, stored, route, cancel: (over?: Partial<ExtensionRequest>, planId = stored.id) => route.handler(request({ planId }, over)) };
}

describe('the cancel route', () => {
  it('is a POST route of its own with a request and an answer schema', () => {
    const route = createAskCancelRoute();
    expect([route.method, route.url, route.permission, route.requestSchema === undefined, route.responseSchema === undefined]).toEqual(['POST', ASK_CANCEL_URL, 'principal', false, false]);
    expect(ASK_CANCEL_URL).toBe('/v1/ask/cancel');
  });

  it('refuses with ASK_UNSUPPORTED when the planner is not available and when there is no store, and cancels nothing', async () => {
    const { plans, stored, cancel } = await setup();
    const none: AskPlanner = { availability: () => ({ available: false, reason: 'x' }), plan: () => Promise.reject(new Error('no')) };
    expect(await refusalOf(cancel({ askPlanner: none }))).toEqual({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
    expect(await refusalOf(createAskCancelRoute().handler(request({ planId: stored.id })))).toEqual({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
    expect(plans.plans[0]?.state).toBe('proposed');
  });

  it('answers NOT_FOUND for a plan that is not there and for another user’s, and cancels nothing', async () => {
    const { plans, cancel } = await setup();
    expect(await refusalOf(cancel(undefined, '01939999-0000-7000-8000-0000000000ff'))).toEqual({ code: 'NOT_FOUND' });
    expect(await refusalOf(cancel({ principalId: 'u-2' }))).toEqual({ code: 'NOT_FOUND' });
    expect(plans.plans[0]?.state).toBe('proposed');
  });

  it('answers CONFLICT plan-expired for an expired plan and plan-not-runnable for one that was cancelled, claimed or run', async () => {
    const { plans, stored, cancel } = await setup();
    await plans.claim(stored.id, 'u-1');
    expect(await refusalOf(cancel())).toEqual({ code: 'CONFLICT', reason: 'plan-not-runnable' });
    await plans.finish({ planId: stored.id, userId: 'u-1', outcome: 'complete', rowCount: 0, elapsedMs: 1 });
    expect(await refusalOf(cancel())).toEqual({ code: 'CONFLICT', reason: 'plan-not-runnable' });
    const second = await plans.insert({ userId: 'u-1', sourceId: 'demo', templateId: 'entity', templateVersion: 1, params: {}, planningTraceId: 'tr-0' });
    await cancel(undefined, second.id);
    expect(await refusalOf(cancel(undefined, second.id))).toEqual({ code: 'CONFLICT', reason: 'plan-not-runnable' });
    const third = await plans.insert({ userId: 'u-1', sourceId: 'demo', templateId: 'entity', templateVersion: 1, params: {}, planningTraceId: 'tr-0' });
    plans.advance(16 * 60_000);
    expect(await refusalOf(cancel(undefined, third.id))).toEqual({ code: 'CONFLICT', reason: 'plan-expired' });
  });

  it('cancels a proposed plan of the caller and says so', async () => {
    const { plans, stored, cancel } = await setup();
    expect(await cancel()).toEqual({ planId: stored.id, state: 'cancelled' });
    expect(plans.plans[0]?.state).toBe('cancelled');
  });

  it('answers a store failure as a failure, not a refusal', async () => {
    const { plans, cancel } = await setup();
    plans.failNext('cancel');
    const failure = await cancel().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'PLAN_STORE_FAILED' });
    expect(parseExtensionRefusal(failure)).toBeUndefined();
    expect(plans.plans[0]?.state).toBe('proposed');
  });
});
