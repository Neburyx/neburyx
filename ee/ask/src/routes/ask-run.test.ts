import { createHmac } from 'node:crypto';
import { askRunResponseSchema, parseExtensionRefusal, type AskPlanRun, type AskPlanRunner, type AskPlanner, type AskRunResult, type AskRunScope, type AuditEvent, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it, vi } from 'vitest';
import { continueTokenOf } from '../plans/continue-token.js';
import { paramsHashOf } from '../plans/params-hash.js';
import { createMemoryPlanStore, type MemoryPlanStore } from '../testing/memory-plans.js';
import { ASK_RUN_ACTION, ASK_RUN_URL, askRunRoute, createAskRunRoute } from './ask-run.js';

const available: AskPlanner = { availability: () => ({ available: true }), plan: () => Promise.reject(new Error('not used')) };
const mac = (key: string) => (canonical: string) => createHmac('sha256', key).update(canonical).digest('hex');
const REF = { entityType: 'node_a', stableId: 'a-secret-1' };
const count = (quality: 'exact' | 'lowerBound', value = 1) => ({ quality, value, scope: 'test' });
const node = { ref: { sourceId: 'demo', ...REF }, display: { title: 'A', type: 'node_a' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
const entityResult: AskRunResult = { templateId: 'entity', result: node };
const sharedResult = (quality: 'exact' | 'lowerBound'): AskRunResult => ({ templateId: 'shared-attribute', result: { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: count(quality, 2), matchIds: [], nodes: [node, node], edges: [], notices: [], warnings: [] } });

interface Rig {
  readonly plans: MemoryPlanStore;
  readonly events: AuditEvent[];
  readonly scopes: AskRunScope[];
  readonly runs: { templateId: string; params: unknown }[];
  readonly options: (({ continue?: boolean }) | undefined)[];
  request(body: unknown, over?: Partial<ExtensionRequest>): ExtensionRequest;
  plan(over?: { templateId?: string; params?: unknown; sourceId?: string; userId?: string }): ReturnType<MemoryPlanStore['insert']>;
}

function rig(answer: (plan: { templateId: string; params: unknown }) => Promise<AskPlanRun> = async () => ({ status: 'ok', result: entityResult }), auditFailure?: Error): Rig {
  const plans = createMemoryPlanStore();
  const events: AuditEvent[] = [];
  const scopes: AskRunScope[] = [];
  const runs: Rig['runs'] = [];
  const options: Rig['options'] = [];
  const runner = (scope: AskRunScope): AskPlanRunner => ({
    run: async (plan, given) => {
      scopes.push(scope);
      runs.push(plan);
      options.push(given);
      return answer(plan);
    },
  });
  const base = { principalId: 'u-1', principalRole: 'investigator', previewOn: true, traceId: 'tr-run', audit: { record: async (event: AuditEvent) => (auditFailure === undefined ? void events.push(event) : Promise.reject(auditFailure)) }, askPlanner: available, previewMac: mac('key-one'), askPlanRunner: runner } as const;
  return {
    plans,
    events,
    scopes,
    runs,
    options,
    request: (body, over = {}) => ({ ...base, body, ...over }),
    plan: (over = {}) => plans.insert({ userId: over.userId ?? 'u-1', sourceId: over.sourceId ?? 'demo', templateId: over.templateId ?? 'entity', templateVersion: 1, params: over.params ?? { ref: REF }, planningTraceId: 'tr-plan' }),
  };
}

const route = (rg: Rig) => createAskRunRoute({ plans: () => rg.plans });
const refusalOf = async (promise: Promise<unknown>) => parseExtensionRefusal(await promise.catch((error: unknown) => error));

describe('the run route', () => {
  it('is a POST route of its own with its request and answer schemas, and its default instance exists', () => {
    expect([askRunRoute.method, askRunRoute.url, askRunRoute.permission, askRunRoute.requestSchema === undefined]).toEqual(['POST', '/v1/ask/run', 'principal', false]);
    expect(ASK_RUN_URL).toBe('/v1/ask/run');
  });
});

describe('a run that is refused before the plan is claimed', () => {
  it('refuses with ASK_UNSUPPORTED, and claims nothing, when the planner is not available, there is no store, no runner or no signing capability', async () => {
    const rg = rig();
    const plan = await rg.plan();
    const body = { planId: plan.id };
    const none: AskPlanner = { availability: () => ({ available: false, reason: 'x' }), plan: () => Promise.reject(new Error('no')) };
    const unsupported = { code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' };
    expect(await refusalOf(route(rg).handler(rg.request(body, { askPlanner: none })))).toEqual(unsupported);
    expect(await refusalOf(createAskRunRoute().handler(rg.request(body)))).toEqual(unsupported);
    expect(await refusalOf(route(rg).handler({ ...rg.request(body), askPlanRunner: undefined }))).toEqual(unsupported);
    expect(await refusalOf(route(rg).handler({ ...rg.request(body), previewMac: undefined }))).toEqual(unsupported);
    expect(rg.plans.plans[0]?.state).toBe('proposed');
    expect(rg.runs).toEqual([]);
    expect(rg.events).toEqual([]);
  });

  it('answers NOT_FOUND, the same for a plan that is not there and for another user’s, and reads nothing and writes no event', async () => {
    const rg = rig();
    const mine = await rg.plan();
    const theirs = await rg.plan({ userId: 'u-2' });
    expect(await refusalOf(route(rg).handler(rg.request({ planId: '01939999-0000-7000-8000-0000000000ff' })))).toEqual({ code: 'NOT_FOUND' });
    expect(await refusalOf(route(rg).handler(rg.request({ planId: theirs.id })))).toEqual({ code: 'NOT_FOUND' });
    expect(rg.plans.plans.map((plan) => plan.state)).toEqual([mine.state, 'proposed']);
    expect(rg.runs).toEqual([]);
    expect(rg.events).toEqual([]);
  });

  it('answers CONFLICT plan-expired for an expired plan, and reads nothing', async () => {
    const rg = rig();
    const plan = await rg.plan();
    rg.plans.advance(16 * 60_000);
    expect(await refusalOf(route(rg).handler(rg.request({ planId: plan.id })))).toEqual({ code: 'CONFLICT', reason: 'plan-expired' });
    expect(rg.runs).toEqual([]);
    expect(rg.events).toEqual([]);
  });

  it('answers CONFLICT plan-not-runnable for a plan that was cancelled, claimed or already ran, and reads nothing', async () => {
    const rg = rig();
    const cancelled = await rg.plan();
    await rg.plans.cancel(cancelled.id, 'u-1');
    const claimed = await rg.plan();
    await rg.plans.claim(claimed.id, 'u-1');
    const ran = await rg.plan();
    await route(rg).handler(rg.request({ planId: ran.id }));
    const readsBefore = rg.runs.length;
    for (const plan of [cancelled, claimed, ran]) expect(await refusalOf(route(rg).handler(rg.request({ planId: plan.id })))).toEqual({ code: 'CONFLICT', reason: 'plan-not-runnable' });
    expect(rg.runs).toHaveLength(readsBefore);
    expect(rg.events).toHaveLength(1);
  });

  it('lets exactly one of two runs of one plan at once read the source, and refuses the other as not runnable', async () => {
    const rg = rig();
    const plan = await rg.plan();
    const results = await Promise.all([route(rg).handler(rg.request({ planId: plan.id })).catch((error: unknown) => error), route(rg).handler(rg.request({ planId: plan.id })).catch((error: unknown) => error)]);
    expect(rg.runs).toHaveLength(1);
    expect(results.filter((result) => parseExtensionRefusal(result)?.code === 'CONFLICT')).toHaveLength(1);
    expect(rg.plans.runs).toHaveLength(1);
    expect(rg.events).toHaveLength(1);
  });
});

describe('a run that the gate refuses or that fails', () => {
  it.each([
    ['a budget', { code: 'QUERY_BUDGET_EXCEEDED', maxPage: 25 }],
    ['a timeout', { code: 'QUERY_TIMEOUT', timeoutMs: 20000 }],
    ['a busy source', { code: 'SOURCE_BUSY' }],
    ['a source that is down', { code: 'SOURCE_UNAVAILABLE', reason: 'unreachable' }],
    ['a rate limit', { code: 'RATE_LIMITED', retryAfterMs: 500 }],
    ['a source the caller lost access to', { code: 'ACCESS_DENIED' }],
    ['a source the caller cannot read', { code: 'NOT_FOUND' }],
  ] as const)('answers the refusal of %s, records the run as failed with the plan as run, and writes one failed event', async (_name, refusal) => {
    const rg = rig(async () => ({ status: 'refused', refusal }));
    const plan = await rg.plan();
    expect(await refusalOf(route(rg).handler(rg.request({ planId: plan.id })))).toEqual(refusal);
    expect(rg.plans.plans[0]?.state).toBe('run');
    expect(rg.plans.runs).toEqual([expect.objectContaining({ planId: plan.id, outcome: 'failed', rowCount: 0 })]);
    expect(rg.events).toEqual([expect.objectContaining({ action: ASK_RUN_ACTION, result: 'failed', detail: { askRun: expect.objectContaining({ rowCount: 0 }) } })]);
  });

  it('records a failure that is not a refusal as a failed run, writes its event and lets the failure out as it is', async () => {
    const failure = new Error('socket hang up');
    const rg = rig(async () => Promise.reject(failure));
    const plan = await rg.plan();
    expect(await route(rg).handler(rg.request({ planId: plan.id })).catch((error: unknown) => error)).toBe(failure);
    expect(rg.plans.plans[0]?.state).toBe('run');
    expect(rg.plans.runs[0]).toMatchObject({ outcome: 'failed' });
    expect(rg.events).toHaveLength(1);
  });

  it('answers an invalid plan, as a failed run, for a stored template that the catalog does not know', async () => {
    const rg = rig();
    const plan = await rg.plan({ templateId: 'free-query' });
    expect(await refusalOf(route(rg).handler(rg.request({ planId: plan.id })))).toEqual({ code: 'ASK_PLAN_INVALID' });
    expect(rg.runs).toEqual([]);
    expect(rg.plans.runs[0]).toMatchObject({ outcome: 'failed' });
  });

  it('gives no result and answers as a failure, with the plan still confirmed and no event, when the finish fails', async () => {
    const rg = rig();
    const plan = await rg.plan();
    rg.plans.failNext('finish');
    const thrown = await route(rg).handler(rg.request({ planId: plan.id })).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ code: 'PLAN_STORE_FAILED' });
    expect(parseExtensionRefusal(thrown)).toBeUndefined();
    expect(rg.plans.plans[0]?.state).toBe('confirmed');
    expect(rg.plans.runs).toEqual([]);
    expect(rg.events).toEqual([]);
  });

  it('answers AUDIT_UNAVAILABLE with no result when the event cannot be written, the run and the plan state being recorded already', async () => {
    const rg = rig(undefined, new Error('audit down'));
    const plan = await rg.plan();
    expect(await refusalOf(route(rg).handler(rg.request({ planId: plan.id })))).toEqual({ code: 'AUDIT_UNAVAILABLE' });
    expect(rg.plans.plans[0]?.state).toBe('run');
    expect(rg.plans.runs).toHaveLength(1);
    expect(await refusalOf(route(rg).handler(rg.request({ planId: plan.id })))).toEqual({ code: 'CONFLICT', reason: 'plan-not-runnable' });
  });

  it('gives the gate’s refusal and no event of a second kind when the event of a failed run cannot be written', async () => {
    const rg = rig(async () => ({ status: 'refused', refusal: { code: 'SOURCE_BUSY' } }), new Error('audit down'));
    const plan = await rg.plan();
    expect(await refusalOf(route(rg).handler(rg.request({ planId: plan.id })))).toEqual({ code: 'AUDIT_UNAVAILABLE' });
    expect(rg.plans.plans[0]?.state).toBe('run');
  });
});

describe('a run that is read', () => {
  it('claims the plan, reads the plan’s own source with the mask the call asked for, and answers the plan, the outcome and the result', async () => {
    const rg = rig();
    const plan = await rg.plan({ sourceId: 'other-source' });
    const answer = askRunResponseSchema.parse(await route(rg).handler(rg.request({ planId: plan.id, mask: true })));
    expect(answer).toEqual({ planId: plan.id, outcome: 'complete', result: entityResult });
    expect(rg.scopes).toEqual([{ sourceId: 'other-source', mask: true }]);
    expect(rg.runs).toEqual([{ templateId: 'entity', params: { ref: REF } }]);
    expect(rg.plans.plans[0]?.state).toBe('run');
  });

  it('does not mask unless asked', async () => {
    const rg = rig();
    const plan = await rg.plan();
    await route(rg).handler(rg.request({ planId: plan.id }));
    expect(rg.scopes[0]?.mask).toBe(false);
  });

  it('writes one run row with the number of elements the result lists and the time the read took, and says partial for a result that reports a cut', async () => {
    const rg = rig(async () => ({ status: 'ok', result: sharedResult('lowerBound') }));
    const plan = await rg.plan({ templateId: 'shared-attribute', params: { ref: REF } });
    const answer = askRunResponseSchema.parse(await route(rg).handler(rg.request({ planId: plan.id })));
    expect(answer.outcome).toBe('partial');
    expect(rg.plans.runs).toEqual([expect.objectContaining({ planId: plan.id, actorId: 'u-1', outcome: 'partial', rowCount: 2, elapsedMs: expect.any(Number) })]);
  });

  it('says complete for a result that reports no cut', async () => {
    const rg = rig(async () => ({ status: 'ok', result: sharedResult('exact') }));
    const plan = await rg.plan({ templateId: 'shared-attribute', params: { ref: REF } });
    expect((await route(rg).handler(rg.request({ planId: plan.id }))) as { outcome: string }).toMatchObject({ outcome: 'complete' });
  });
});

describe('the audit event of a run', () => {
  it('holds the actor, the role, the source, the plan, the trace, the result, the template and a keyed hash of the parameters, and the row count, and nothing typed', async () => {
    const rg = rig();
    const plan = await rg.plan({ params: { ref: REF } });
    await route(rg).handler(rg.request({ planId: plan.id }));
    expect(rg.events).toEqual([
      {
        actorId: 'u-1',
        actorRole: 'investigator',
        action: 'ask.run',
        result: 'success',
        sourceId: 'demo',
        resourceType: 'ask-plan',
        resourceRef: plan.id,
        traceId: 'tr-run',
        detail: { askRun: { templateId: 'entity', templateVersion: 1, paramsHash: paramsHashOf(mac('key-one'), { ref: REF }), rowCount: 1 } },
      },
    ]);
    expect(JSON.stringify(rg.events)).not.toContain('a-secret-1');
  });

  it('says partial for a partial run', async () => {
    const rg = rig(async () => ({ status: 'ok', result: sharedResult('lowerBound') }));
    const plan = await rg.plan({ templateId: 'shared-attribute' });
    await route(rg).handler(rg.request({ planId: plan.id }));
    expect(rg.events[0]).toMatchObject({ result: 'partial', detail: { askRun: { rowCount: 2 } } });
  });

  it('is written after the finish: the record is there when the event is made', async () => {
    const rg = rig();
    const plan = await rg.plan();
    const seen: number[] = [];
    const request = rg.request({ planId: plan.id });
    await route(rg).handler({ ...request, audit: { record: async () => void seen.push(rg.plans.runs.length) } });
    expect(seen).toEqual([1]);
  });
});

describe('the hash of the parameters', () => {
  it('is keyed: the same parameters under another key give another hash, and the same key gives the same hash for the same parameters whatever the order of their keys', () => {
    const params = { ref: REF, limit: 5 };
    expect(paramsHashOf(mac('key-one'), params)).toMatch(/^[0-9a-f]{64}$/);
    expect(paramsHashOf(mac('key-one'), params)).toBe(paramsHashOf(mac('key-one'), { limit: 5, ref: { stableId: REF.stableId, entityType: REF.entityType } }));
    expect(paramsHashOf(mac('key-two'), params)).not.toBe(paramsHashOf(mac('key-one'), params));
  });

  it('is of a text that opens with the purpose label, never the text of a preview', () => {
    const signed: string[] = [];
    paramsHashOf((canonical) => (signed.push(canonical), 'a'.repeat(64)), { ref: REF });
    expect(JSON.parse(signed[0] ?? '[]')[0]).toBe('ask-run-params');
    expect(JSON.parse(signed[0] ?? '[]')[1]).toBe(1);
  });

  it('refuses a signature that is not 64 lowercase hex characters', () => {
    expect(() => paramsHashOf(() => 'short', {})).toThrow();
  });
});

describe('a mac that is a spy', () => {
  it('is asked once for the parameters of one run', async () => {
    const rg = rig();
    const plan = await rg.plan();
    const spy = vi.fn(mac('key-one'));
    await route(rg).handler(rg.request({ planId: plan.id }, { previewMac: spy }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

const heavyResult: AskRunResult = { templateId: 'shared-attribute', result: { status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', estimate: count('lowerBound', 1000), threshold: 1000, continueLimit: 25, notices: [], warnings: [] } };
const TEMPLATE_PARAMS = { ref: REF, attributeType: 'attr_type', via: 'link_a' };

describe('a run that stops as heavy', () => {
  it('gives the plan back as proposed with its expiry unchanged, writes no run and no event, and answers the stop with a token for this plan and its stored parameters', async () => {
    const rg = rig(async () => ({ status: 'ok', result: heavyResult }));
    const plan = await rg.plan({ templateId: 'shared-attribute', params: TEMPLATE_PARAMS });
    const answer = askRunResponseSchema.parse(await route(rg).handler(rg.request({ planId: plan.id })));
    expect(answer).toEqual({ planId: plan.id, outcome: 'partial', result: heavyResult, continueToken: continueTokenOf(mac('key-one'), plan.id, TEMPLATE_PARAMS) });
    expect(rg.plans.plans[0]).toMatchObject({ state: 'proposed', expiresAt: plan.expiresAt, params: TEMPLATE_PARAMS });
    expect(rg.plans.runs).toEqual([]);
    expect(rg.events).toEqual([]);
  });

  it('gives no result and no token, and leaves the plan confirmed, when the release fails', async () => {
    const rg = rig(async () => ({ status: 'ok', result: heavyResult }));
    const plan = await rg.plan({ templateId: 'shared-attribute', params: TEMPLATE_PARAMS });
    rg.plans.failNext('release');
    const thrown = await route(rg).handler(rg.request({ planId: plan.id })).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ code: 'PLAN_STORE_FAILED' });
    expect(rg.plans.plans[0]?.state).toBe('confirmed');
    expect(rg.plans.runs).toEqual([]);
    expect(rg.events).toEqual([]);
  });

  it('lets the plan be run again after the release, until its original expiry, and not after it', async () => {
    let heavy = true;
    const rg = rig(async () => ({ status: 'ok', result: heavy ? heavyResult : sharedResult('exact') }));
    const plan = await rg.plan({ templateId: 'shared-attribute', params: TEMPLATE_PARAMS });
    await route(rg).handler(rg.request({ planId: plan.id }));
    heavy = false;
    expect(askRunResponseSchema.parse(await route(rg).handler(rg.request({ planId: plan.id }))).outcome).toBe('complete');
    const second = await rg.plan({ templateId: 'shared-attribute', params: TEMPLATE_PARAMS });
    heavy = true;
    await route(rg).handler(rg.request({ planId: second.id }));
    rg.plans.advance(16 * 60_000);
    expect(await refusalOf(route(rg).handler(rg.request({ planId: second.id })))).toEqual({ code: 'CONFLICT', reason: 'plan-expired' });
  });

  it('is released again, with a token, when a continued run of a plan kind that can stop again stops as heavy', async () => {
    const rg = rig(async () => ({ status: 'ok', result: heavyResult }));
    const plan = await rg.plan({ templateId: 'shared-attribute', params: TEMPLATE_PARAMS });
    const token = continueTokenOf(mac('key-one'), plan.id, TEMPLATE_PARAMS);
    const answer = askRunResponseSchema.parse(await route(rg).handler(rg.request({ planId: plan.id, continue: true, continueToken: token })));
    expect(answer.continueToken).toBe(token);
    expect(rg.plans.plans[0]?.state).toBe('proposed');
    expect(rg.plans.runs).toEqual([]);
  });

  it('does not set the continue flag for a run that has no token', async () => {
    const rg = rig();
    const plan = await rg.plan();
    await route(rg).handler(rg.request({ planId: plan.id }));
    expect(rg.options).toEqual([{ continue: false }]);
  });
});

describe('a continue', () => {
  const planFor = async (rg: Rig) => rg.plan({ templateId: 'shared-attribute', params: TEMPLATE_PARAMS });
  const good = (planId: string) => continueTokenOf(mac('key-one'), planId, TEMPLATE_PARAMS);

  it.each([
    ['a token of another key', continueTokenOf(mac('key-two'), 'x', TEMPLATE_PARAMS)],
    ['the token of another plan', continueTokenOf(mac('key-one'), '01939999-0000-7000-8000-0000000000dd', TEMPLATE_PARAMS)],
    ['the token of other parameters', continueTokenOf(mac('key-one'), 'PLAN', { ...TEMPLATE_PARAMS, limit: 9 })],
  ])('is refused as an invalid request, with nothing claimed or read, for %s', async (_name, token) => {
    const rg = rig();
    const plan = await planFor(rg);
    const body = { planId: plan.id, continue: true, ...(token === undefined ? {} : { continueToken: token === 'PLAN' ? undefined : token }) };
    const request = rg.request(body);
    expect(await refusalOf(route(rg).handler(request))).toEqual({ code: 'INVALID_REQUEST', reason: 'continue-token' });
    expect(rg.plans.plans[0]?.state).toBe('proposed');
    expect(rg.runs).toEqual([]);
    expect(rg.events).toEqual([]);
  });

  it.each([
    ['a continue with no token', { continue: true }],
    ['a token with no continue', { continueToken: 'c'.repeat(64) }],
    ['a token that is not the shape', { continue: true, continueToken: 'abc' }],
  ])('is refused as a malformed body, with nothing claimed or read, for %s', async (_name, extra) => {
    const rg = rig();
    const plan = await planFor(rg);
    expect(await refusalOf(route(rg).handler(rg.request({ planId: plan.id, ...extra })))).toEqual({ code: 'INVALID_REQUEST', reason: 'body' });
    expect(rg.plans.plans[0]?.state).toBe('proposed');
    expect(rg.runs).toEqual([]);
  });

  it('is refused for a token made for a plan with other parameters than the plan holds now', async () => {
    const rg = rig();
    const plan = await planFor(rg);
    const stale = continueTokenOf(mac('key-one'), plan.id, { ...TEMPLATE_PARAMS, limit: 9 });
    expect(await refusalOf(route(rg).handler(rg.request({ planId: plan.id, continue: true, continueToken: stale })))).toEqual({ code: 'INVALID_REQUEST', reason: 'continue-token' });
    expect(rg.runs).toEqual([]);
  });

  it('answers NOT_FOUND, plan-expired and plan-not-runnable before it looks at the token, whatever the token is', async () => {
    const rg = rig();
    const wrong = 'd'.repeat(64);
    expect(await refusalOf(route(rg).handler(rg.request({ planId: '01939999-0000-7000-8000-0000000000ff', continue: true, continueToken: wrong })))).toEqual({ code: 'NOT_FOUND' });
    const other = await rg.plan({ userId: 'u-2', templateId: 'shared-attribute', params: TEMPLATE_PARAMS });
    expect(await refusalOf(route(rg).handler(rg.request({ planId: other.id, continue: true, continueToken: wrong })))).toEqual({ code: 'NOT_FOUND' });
    const cancelled = await planFor(rg);
    await rg.plans.cancel(cancelled.id, 'u-1');
    expect(await refusalOf(route(rg).handler(rg.request({ planId: cancelled.id, continue: true, continueToken: wrong })))).toEqual({ code: 'CONFLICT', reason: 'plan-not-runnable' });
    const late = await planFor(rg);
    rg.plans.advance(16 * 60_000);
    expect(await refusalOf(route(rg).handler(rg.request({ planId: late.id, continue: true, continueToken: wrong })))).toEqual({ code: 'CONFLICT', reason: 'plan-expired' });
    expect(rg.runs).toEqual([]);
  });

  it('claims the plan, runs it with the continue flag, finishes and audits it like any run, when the token is the plan\u2019s', async () => {
    const rg = rig(async () => ({ status: 'ok', result: sharedResult('exact') }));
    const plan = await planFor(rg);
    const answer = askRunResponseSchema.parse(await route(rg).handler(rg.request({ planId: plan.id, continue: true, continueToken: good(plan.id) })));
    expect(answer).toMatchObject({ outcome: 'complete', result: { templateId: 'shared-attribute' } });
    expect(answer.continueToken).toBeUndefined();
    expect(rg.options).toEqual([{ continue: true }]);
    expect(rg.plans.plans[0]?.state).toBe('run');
    expect(rg.plans.runs).toHaveLength(1);
    expect(rg.events).toHaveLength(1);
  });

  it('cannot be used twice: the second continue is refused as not runnable, and reads nothing', async () => {
    const rg = rig(async () => ({ status: 'ok', result: sharedResult('exact') }));
    const plan = await planFor(rg);
    await route(rg).handler(rg.request({ planId: plan.id, continue: true, continueToken: good(plan.id) }));
    expect(await refusalOf(route(rg).handler(rg.request({ planId: plan.id, continue: true, continueToken: good(plan.id) })))).toEqual({ code: 'CONFLICT', reason: 'plan-not-runnable' });
    expect(rg.runs).toHaveLength(1);
  });

  it('is voided by an edit: the old plan is cancelled and the new plan has another token', async () => {
    const rg = rig();
    const plan = await planFor(rg);
    const token = good(plan.id);
    const edited = await rg.plans.edit({ planId: plan.id, userId: 'u-1', templateId: 'shared-attribute', templateVersion: 1, params: { ...TEMPLATE_PARAMS, limit: 3 } });
    if (edited.status !== 'edited') throw new Error('not edited');
    expect(await refusalOf(route(rg).handler(rg.request({ planId: plan.id, continue: true, continueToken: token })))).toEqual({ code: 'CONFLICT', reason: 'plan-not-runnable' });
    expect(await refusalOf(route(rg).handler(rg.request({ planId: edited.plan.id, continue: true, continueToken: token })))).toEqual({ code: 'INVALID_REQUEST', reason: 'continue-token' });
  });

  it('refuses with ASK_UNSUPPORTED, before the token, when the signing capability is missing', async () => {
    const rg = rig();
    const plan = await planFor(rg);
    expect(await refusalOf(route(rg).handler({ ...rg.request({ planId: plan.id, continue: true, continueToken: 'e'.repeat(64) }), previewMac: undefined }))).toEqual({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
  });
});


describe('a plan that names a saved pattern', () => {
  const PATTERN = '0195a000-0000-7000-8000-000000000001';
  const SAVED_PARAMS = { patternId: PATTERN, patternVersion: 3, ref: REF };
  const savedOk = (over: Record<string, unknown> = {}): AskRunResult => ({ templateId: 'saved-pattern', result: { status: 'ok', templateVersion: '1', count: count('exact', 1), matches: [], nodes: [node], edges: [], notices: [], warnings: [], ...over } as never });
  const savedHeavy: AskRunResult = { templateId: 'saved-pattern', result: { status: 'heavy', templateVersion: '1', estimate: count('lowerBound', 500), threshold: 500, continueLimit: 25, notices: [], warnings: [] } as never };

  it('is run with the id, version and starting entity it holds, and answers the saved run’s result and the outcome of its count', async () => {
    const rg = rig(async () => ({ status: 'ok', result: savedOk() }));
    const plan = await rg.plan({ templateId: 'saved-pattern', params: SAVED_PARAMS });
    const answer = askRunResponseSchema.parse(await route(rg).handler(rg.request({ planId: plan.id })));
    expect(answer).toMatchObject({ planId: plan.id, outcome: 'complete', result: { templateId: 'saved-pattern' } });
    expect(rg.runs).toEqual([{ templateId: 'saved-pattern', params: SAVED_PARAMS }]);
    expect(rg.plans.runs).toMatchObject([{ planId: plan.id, outcome: 'complete', rowCount: 1 }]);
  });

  it('says partial for a saved run that reports a cut, by a lower-bound count or a next page', async () => {
    for (const over of [{ count: count('lowerBound', 25) }, { nextCursor: 'c1' }]) {
      const rg = rig(async () => ({ status: 'ok', result: savedOk(over) }));
      const plan = await rg.plan({ templateId: 'saved-pattern', params: SAVED_PARAMS });
      expect(askRunResponseSchema.parse(await route(rg).handler(rg.request({ planId: plan.id }))).outcome).toBe('partial');
    }
  });

  it.each([
    ['a pattern that changed', { code: 'CONFLICT', reason: 'pattern-changed' } as const],
    ['a pattern that is unavailable', { code: 'CONFLICT', reason: 'pattern-unavailable' } as const],
    ['a pattern that is no longer the caller’s', { code: 'NOT_FOUND' } as const],
  ])('answers the refusal for %s, records a failed run with no rows, and writes the event of a failed run', async (_name, refusal) => {
    const rg = rig(async () => ({ status: 'refused', refusal }));
    const plan = await rg.plan({ templateId: 'saved-pattern', params: SAVED_PARAMS });
    expect(await refusalOf(route(rg).handler(rg.request({ planId: plan.id })))).toEqual(refusal);
    expect(rg.plans.plans[0]?.state).toBe('run');
    expect(rg.plans.runs).toMatchObject([{ outcome: 'failed', rowCount: 0 }]);
    expect(rg.events).toMatchObject([{ action: ASK_RUN_ACTION, result: 'failed' }]);
  });

  it('gives the plan back when the saved run stops as heavy, with a token for the stored id and version, writes no run and no event, and runs it with the token', async () => {
    const rg = rig(async () => ({ status: 'ok', result: savedHeavy }));
    const plan = await rg.plan({ templateId: 'saved-pattern', params: SAVED_PARAMS });
    const answer = askRunResponseSchema.parse(await route(rg).handler(rg.request({ planId: plan.id })));
    const token = continueTokenOf(mac('key-one'), plan.id, SAVED_PARAMS);
    expect(answer).toMatchObject({ outcome: 'partial', continueToken: token });
    expect(rg.plans.plans[0]).toMatchObject({ state: 'proposed', expiresAt: plan.expiresAt });
    expect(rg.plans.runs).toEqual([]);
    expect(rg.events).toEqual([]);
    const next = rig(async (given) => ({ status: 'ok', result: given.templateId === 'saved-pattern' ? savedOk() : entityResult }));
    const again = await next.plan({ templateId: 'saved-pattern', params: SAVED_PARAMS });
    const second = await route(next).handler(next.request({ planId: again.id, continue: true, continueToken: continueTokenOf(mac('key-one'), again.id, SAVED_PARAMS) }));
    expect(askRunResponseSchema.parse(second).outcome).toBe('complete');
    expect(next.options).toEqual([{ continue: true }]);
  });

  it('refuses a continue with a token made for another pattern or version of the same plan’s parameters, before anything is read', async () => {
    const rg = rig();
    const plan = await rg.plan({ templateId: 'saved-pattern', params: SAVED_PARAMS });
    const other = continueTokenOf(mac('key-one'), plan.id, { ...SAVED_PARAMS, patternVersion: 4 });
    expect(await refusalOf(route(rg).handler(rg.request({ planId: plan.id, continue: true, continueToken: other })))).toEqual({ code: 'INVALID_REQUEST', reason: 'continue-token' });
    expect(rg.runs).toEqual([]);
    expect(rg.plans.plans[0]?.state).toBe('proposed');
  });

  it('holds the id and version of the pattern, the same fields as any run, and a refused run holds them too', async () => {
    const rg = rig(async () => ({ status: 'refused', refusal: { code: 'CONFLICT', reason: 'pattern-changed' } }));
    const plan = await rg.plan({ templateId: 'saved-pattern', params: SAVED_PARAMS });
    await refusalOf(route(rg).handler(rg.request({ planId: plan.id })));
    expect(rg.events[0]).toMatchObject({ result: 'failed', detail: { askRun: { patternId: PATTERN, patternVersion: 3, rowCount: 0 } } });
  });

  it('holds no pattern id in the event of a run of a template', async () => {
    const rg = rig();
    const plan = await rg.plan();
    await route(rg).handler(rg.request({ planId: plan.id }));
    expect(rg.events[0]?.detail).not.toHaveProperty('askRun.patternId');
  });

  it('holds no name, key or typed text in the event of its run', async () => {
    const rg = rig(async () => ({ status: 'ok', result: savedOk() }));
    const plan = await rg.plan({ templateId: 'saved-pattern', params: SAVED_PARAMS });
    await route(rg).handler(rg.request({ planId: plan.id }));
    expect(rg.events[0]?.detail).toMatchObject({ askRun: { templateId: 'saved-pattern', templateVersion: 1, rowCount: 1, patternId: PATTERN, patternVersion: 3 } });
    expect(JSON.stringify(rg.events)).not.toMatch(/a-secret-1|pat_/);
  });
});

describe('the summary of a run answer', () => {
  const warnings: { fields: Record<string, unknown>; message: string }[] = [];
  const withLogger = (rg: Rig) => createAskRunRoute({ plans: () => rg.plans, logger: () => ({ warn: (fields, message) => void warnings.push({ fields, message }) }) });

  it('carries a summary of the result of a run that completes, built after the run is recorded and audited, and the answer is the same otherwise', async () => {
    warnings.length = 0;
    const rg = rig();
    const plan = await rg.plan();
    const answer = askRunResponseSchema.parse(await withLogger(rg).handler(rg.request({ planId: plan.id })));
    expect(answer.summary?.sentences[0]?.text).toBe('A is of type node_a.');
    expect(answer).toMatchObject({ planId: plan.id, outcome: 'complete', result: entityResult });
    expect(rg.events).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('carries a summary of a partial run too, with the count of the cut in its words', async () => {
    const rg = rig(async () => ({ status: 'ok', result: sharedResult('lowerBound') }));
    const plan = await rg.plan({ templateId: 'shared-attribute', params: TEMPLATE_PARAMS });
    const answer = askRunResponseSchema.parse(await withLogger(rg).handler(rg.request({ planId: plan.id })));
    expect(answer.outcome).toBe('partial');
    expect(answer.summary?.sentences.map((sentence) => sentence.text).join(' ')).toContain('≥ 2 · lower bound');
  });

  it('leaves no summary text in the audit event or the run row, and leaves the plan run', async () => {
    const rg = rig();
    const plan = await rg.plan();
    const answer = askRunResponseSchema.parse(await withLogger(rg).handler(rg.request({ planId: plan.id })));
    expect(answer.summary).toBeDefined();
    expect(JSON.stringify(rg.events)).not.toContain('is of type');
    expect(JSON.stringify(rg.plans.runs)).not.toContain('is of type');
    expect(rg.plans.plans[0]?.state).toBe('run');
    expect(Object.keys(rg.events[0]?.detail ?? {})).toEqual(['askRun']);
  });

  it('drops a summary whose citations are not of the plan’s source, logs one warning with a fixed code and no value, and leaves the outcome and the result as they were', async () => {
    warnings.length = 0;
    const rg = rig();
    const plan = await rg.plan({ sourceId: 'other-source' });
    const answer = askRunResponseSchema.parse(await withLogger(rg).handler(rg.request({ planId: plan.id })));
    expect(answer).toEqual({ planId: plan.id, outcome: 'complete', result: entityResult });
    expect(warnings).toEqual([{ fields: { event: 'ask-summary-dropped', code: 'other-source' }, message: 'a summary was left out of a run answer' }]);
    expect(rg.plans.plans[0]?.state).toBe('run');
  });

  it('drops a summary when the builder throws, and answers as before', async () => {
    warnings.length = 0;
    const hostile = { ...entityResult, result: new Proxy(node, { get: (target, key) => (key === 'display' ? Reflect.get(target, key) : (() => { throw new Error('boom'); })()) }) } as unknown as AskRunResult;
    const rg = rig(async () => ({ status: 'ok', result: hostile }));
    const plan = await rg.plan();
    const answer = await withLogger(rg).handler(rg.request({ planId: plan.id }));
    expect(answer).not.toHaveProperty('summary');
    expect(warnings.map((entry) => entry.fields)).toEqual([{ event: 'ask-summary-dropped', code: 'builder-threw' }]);
    expect(rg.events).toHaveLength(1);
  });

  it('has no summary for a run that stops as heavy, and none for a run that fails', async () => {
    const heavy = rig(async () => ({ status: 'ok', result: heavyResult }));
    const stopped = await heavy.plan({ templateId: 'shared-attribute', params: TEMPLATE_PARAMS });
    expect(await withLogger(heavy).handler(heavy.request({ planId: stopped.id }))).not.toHaveProperty('summary');
    const failing = rig(async () => Promise.reject(new Error('read failed')));
    const failed = await failing.plan();
    const thrown = await withLogger(failing).handler(failing.request({ planId: failed.id })).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Error);
  });
});
