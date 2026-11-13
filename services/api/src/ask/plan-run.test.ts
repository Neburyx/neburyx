import { rmSync } from 'node:fs';
import { askRunResponseSchema, type AskPlanner, type AuditEvent } from '@neburyx/contracts';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { SHARED_ATTRIBUTE_ID } from '../gate/templates/shared-attribute.js';
import { SHARED_ATTRIBUTE_COUNT_ID } from '../gate/templates/shared-attribute-count.js';
import { createLogger } from '../logger.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { TestExecutor } from '../testing/gate.js';
import { createListPlanStore } from '../testing/list-plan-store.js';
import { principalFixture } from '../testing/principal-fixture.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { noMatchRow, sharedMappingOf, sharedRow } from '../testing/shared-attribute-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

vi.mock('@neburyx/ee-audit', () => ({ createAuditSink: () => ({ sink: { record: () => Promise.resolve() }, close: async () => undefined }) }));

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const available: AskPlanner = { availability: () => ({ available: true }), plan: () => Promise.reject(new Error('not used')) };
const REF = { entityType: 'maker', stableId: 'A-1' };
const SHARED = { templateId: 'shared-attribute', params: { ref: REF, attributeType: 'tool', via: 'USES_TOOL' } };

interface Options {
  readonly rows?: readonly Record<string, unknown>[];
  readonly answer?: (call: ExecuteCall) => Promise<ExecuteOutcome>;
  readonly deny?: boolean;
  readonly mapping?: Record<string, number>;
  /** The matches the estimate reads before the run; more than the source's `heavy_op_threshold` stops the run as heavy. */
  readonly probeMatches?: number;
}

async function started(options: Options = {}) {
  const mapping = sharedMappingOf(options.mapping === undefined ? {} : { budgets: options.mapping });
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const probe: ExecuteOutcome = { status: 'rows', rows: [{ matches: options.probeMatches ?? 0, anchorBounded: false, skipped: false }] };
  const base = options.answer ?? ((call: ExecuteCall): Promise<ExecuteOutcome> => Promise.resolve(call.templateId === SHARED_ATTRIBUTE_COUNT_ID ? probe : { status: 'rows', rows: options.rows ?? [] }));
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), base));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = {
    policy: options.deny === true ? { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no' }) } : defaults.policy,
    coordinator: defaults.coordinator,
    audit: { record: (event) => (events.push(event), Promise.resolve()) },
  };
  const parts = testSourceGate(mapping, { executor, seams });
  const plans = createListPlanStore();
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams: { ...seams, askPlanner: available } as Seams, extension: createEnterpriseExtension({ planStore: plans }), previewOn: true });
  return { app, executor, events, plans };
}

type Started = Awaited<ReturnType<typeof started>>;
const run = (rig: Started, body: object) => rig.app.inject({ method: 'POST', url: '/v1/ask/run', payload: body });
const sharedRuns = (rig: Started) => rig.executor.calls.filter((call) => call.templateId === SHARED_ATTRIBUTE_ID);
const stored = (rig: Started, over: Record<string, unknown> = {}) => rig.plans.put({ userId: principalFixture.id, ...SHARED, ...over } as never);

describe('a run of a plan through the application and the gate', () => {
  it('runs a stored shared-attribute plan by the template run service, through the gate, and answers the same nodes and count as the manual route would', async () => {
    const rig = await started({ rows: [sharedRow({ match: 'O-1', tools: ['D-1', 'D-2'] }), sharedRow({ match: 'O-2' })] });
    const plan = stored(rig);
    const response = await run(rig, { planId: plan.id });
    expect(response.statusCode).toBe(200);
    const body = askRunResponseSchema.parse(response.json());
    expect(body).toMatchObject({ planId: plan.id, outcome: 'complete', result: { templateId: 'shared-attribute', result: { status: 'ok', count: { value: 2, quality: 'exact' } } } });
    expect(sharedRuns(rig)).toHaveLength(1);
    expect(rig.plans.runs).toEqual([{ planId: plan.id, actorId: principalFixture.id, outcome: 'complete', rowCount: 5 }]);
    expect(rig.plans.stored[0]?.state).toBe('run');
    await rig.app.close();
  });

  it('says partial, with the count labelled a lower bound, when the read was cut', async () => {
    const rig = await started({ rows: Array.from({ length: 4 }, (_unused, index) => sharedRow({ match: `O-${index + 1}` })) });
    const plan = stored(rig, { params: { ...SHARED.params, limit: 3 } });
    const body = askRunResponseSchema.parse((await run(rig, { planId: plan.id })).json());
    expect(body.outcome).toBe('partial');
    expect(body.result).toMatchObject({ result: { count: { value: 3, quality: 'lowerBound' } } });
    expect(rig.plans.runs[0]).toMatchObject({ outcome: 'partial' });
    await rig.app.close();
  });

  it('answers an exact zero for an anchor that exists and has no match', async () => {
    const rig = await started({ rows: [noMatchRow()] });
    const body = askRunResponseSchema.parse((await run(rig, { planId: stored(rig).id })).json());
    expect(body).toMatchObject({ outcome: 'complete', result: { result: { matchIds: [], count: { value: 0, quality: 'exact' } } } });
    await rig.app.close();
  });

  it.each([
    ['a source that is unavailable', { status: 'unavailable' as const, reason: 'unreachable' as const }, 503, 'SOURCE_UNAVAILABLE'],
    ['a read that runs out of time', { status: 'timeout' as const }, 504, 'QUERY_TIMEOUT'],
  ])('answers the refusal of %s as the manual route does, with a failed run, the plan as run and no result', async (_name, outcome, status, code) => {
    const rig = await started({ answer: (call) => Promise.resolve(call.templateId === SHARED_ATTRIBUTE_COUNT_ID ? { status: 'rows', rows: [{ matches: 0, anchorBounded: false, skipped: false }] } : outcome) });
    const plan = stored(rig);
    const response = await run(rig, { planId: plan.id });
    expect([response.statusCode, response.json().error.code]).toEqual([status, code]);
    expect(response.json()).not.toHaveProperty('result');
    expect(rig.plans.runs).toEqual([expect.objectContaining({ planId: plan.id, outcome: 'failed', rowCount: 0 })]);
    expect(rig.plans.stored[0]?.state).toBe('run');
    await rig.app.close();
  });

  it('answers QUERY_BUDGET_EXCEEDED with the page bound of the manual route for a limit above the max_page of the source, with a failed run and nothing read', async () => {
    const rig = await started({ rows: [sharedRow({ match: 'O-1' })] });
    const plan = stored(rig, { params: { ...SHARED.params, limit: 51 } });
    const response = await run(rig, { planId: plan.id });
    expect([response.statusCode, response.json().error.code]).toEqual([422, 'QUERY_BUDGET_EXCEEDED']);
    expect(sharedRuns(rig)).toHaveLength(0);
    expect(rig.plans.runs[0]).toMatchObject({ outcome: 'failed' });
    await rig.app.close();
  });

  it('answers SOURCE_BUSY as the manual route does when the estimate cannot get a read slot, and starts no run', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let seen = 0;
    const rig = await started({
      mapping: { user_concurrency: 1, queue_wait_ms: 100 },
      answer: async (call) => (call.templateId === SHARED_ATTRIBUTE_COUNT_ID ? (++seen === 1 && (await held), { status: 'rows' as const, rows: [{ matches: 0, anchorBounded: false, skipped: false }] }) : { status: 'rows' as const, rows: [sharedRow({ match: 'O-1' })] }),
    });
    const first = run(rig, { planId: stored(rig).id });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = rig.plans.put({ userId: principalFixture.id, ...SHARED, id: '01939999-0000-7000-8000-0000000000cc' } as never);
    const refused = await run(rig, { planId: second.id });
    expect([refused.statusCode, refused.json().error.code]).toEqual([503, 'SOURCE_BUSY']);
    expect(sharedRuns(rig)).toHaveLength(0);
    release();
    expect((await first).statusCode).toBe(200);
    await rig.app.close();
  });

  it('refuses as the manual reads do, with nothing read, when the caller lost access to the source since the plan was proposed', async () => {
    const rig = await started({ deny: true, rows: [sharedRow({ match: 'O-1' })] });
    const plan = stored(rig);
    const response = await run(rig, { planId: plan.id });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(sharedRuns(rig)).toHaveLength(0);
    expect(rig.plans.runs[0]).toMatchObject({ outcome: 'failed' });
    await rig.app.close();
  });

  it('reads only the source the plan holds, not one the call names: a body with another source is malformed', async () => {
    const rig = await started({ rows: [sharedRow({ match: 'O-1' })] });
    const plan = stored(rig);
    const response = await run(rig, { planId: plan.id, sourceId: 'elsewhere' });
    expect(response.statusCode).toBe(400);
    expect(sharedRuns(rig)).toHaveLength(0);
    await rig.app.close();
  });

  it('runs a plan once: the second call is refused as not runnable and reads nothing', async () => {
    const rig = await started({ rows: [sharedRow({ match: 'O-1' })] });
    const plan = stored(rig);
    expect((await run(rig, { planId: plan.id })).statusCode).toBe(200);
    const again = await run(rig, { planId: plan.id });
    expect([again.statusCode, again.json().error.code, again.json().error.details]).toEqual([409, 'CONFLICT', { reason: 'plan-not-runnable' }]);
    expect(sharedRuns(rig)).toHaveLength(1);
    await rig.app.close();
  });

  it('answers NOT_FOUND for a plan of another user and reads nothing', async () => {
    const rig = await started({ rows: [sharedRow({ match: 'O-1' })] });
    const plan = rig.plans.put({ userId: '0192f000-0000-7000-8000-0000000000ff', ...SHARED } as never);
    expect((await run(rig, { planId: plan.id })).statusCode).toBe(404);
    expect(sharedRuns(rig)).toHaveLength(0);
    await rig.app.close();
  });
});

describe('a run that stops as heavy, and its continue', () => {
  const heavyRig = () => started({ mapping: { heavy_op_threshold: 3 }, probeMatches: 4, rows: [sharedRow({ match: 'O-1' }), sharedRow({ match: 'O-2' })] });

  it('answers the stop of the service with a token, gives the plan back, reads no rows and writes no run row and no run event', async () => {
    const rig = await heavyRig();
    const plan = stored(rig);
    const response = await run(rig, { planId: plan.id });
    expect(response.statusCode).toBe(200);
    const body = askRunResponseSchema.parse(response.json());
    expect(body).toMatchObject({ planId: plan.id, outcome: 'partial', result: { templateId: 'shared-attribute', result: { status: 'heavy', threshold: 3 } }, continueToken: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(rig.plans.stored[0]?.state).toBe('proposed');
    expect(rig.plans.runs).toEqual([]);
    expect(rig.events.filter((event) => event.action === 'ask.run')).toEqual([]);
    expect(sharedRuns(rig)).toHaveLength(0);
    await rig.app.close();
  });

  it('reads one bounded page, without an estimate, when the plan is continued with its token, and runs it as any run', async () => {
    const rig = await heavyRig();
    const plan = stored(rig);
    const stop = askRunResponseSchema.parse((await run(rig, { planId: plan.id })).json());
    const probesBefore = rig.executor.calls.filter((call) => call.templateId === SHARED_ATTRIBUTE_COUNT_ID).length;
    const response = await run(rig, { planId: plan.id, continue: true, continueToken: stop.continueToken });
    expect(response.statusCode).toBe(200);
    const body = askRunResponseSchema.parse(response.json());
    expect(body).toMatchObject({ outcome: expect.stringMatching(/complete|partial/), result: { templateId: 'shared-attribute', result: { status: 'ok' } } });
    expect(body.continueToken).toBeUndefined();
    expect(rig.executor.calls.filter((call) => call.templateId === SHARED_ATTRIBUTE_COUNT_ID)).toHaveLength(probesBefore);
    expect(sharedRuns(rig)).toHaveLength(1);
    expect(sharedRuns(rig)[0]?.parameters['limit']).toBe(25);
    expect(rig.plans.stored[0]?.state).toBe('run');
    expect(rig.plans.runs).toHaveLength(1);
    expect(rig.events.filter((event) => event.action === 'ask.run')).toHaveLength(1);
    await rig.app.close();
  });

  it('refuses a continue with no token, a token of another plan or a token with no continue, before anything is claimed or read', async () => {
    const rig = await heavyRig();
    const first = stored(rig);
    const second = rig.plans.put({ userId: principalFixture.id, ...SHARED, id: '01939999-0000-7000-8000-0000000000cc' } as never);
    const stop = askRunResponseSchema.parse((await run(rig, { planId: first.id })).json());
    for (const body of [{ planId: second.id, continue: true, continueToken: stop.continueToken }, { planId: first.id, continue: true }, { planId: first.id, continueToken: stop.continueToken }, { planId: first.id, continue: true, continueToken: 'a'.repeat(64) }]) {
      const response = await run(rig, body);
      expect([response.statusCode, response.json().error.code]).toEqual([400, 'INVALID_REQUEST']);
    }
    expect(sharedRuns(rig)).toHaveLength(0);
    expect(rig.plans.stored.map((plan) => plan.state)).toEqual(['proposed', 'proposed']);
    await rig.app.close();
  });
});

