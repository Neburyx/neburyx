import type { AuditSinkContext } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { PLAN_POOL_SIZE, PlanStoreError, createPlanStore, type PlanClient, type PlanPool, type PlanQueryResult } from './store.js';

const NEW_ID = '01939999-0000-7000-8000-000000000001';
const USER = '01939999-0000-7000-8000-0000000000aa';
const PLAN = '01939999-0000-7000-8000-0000000000bb';

type Row = Record<string, unknown>;
interface Call {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
  readonly on: 'pool' | 'client';
}

/** A pool that answers each statement from a script, in the order the statements arrive, and records them. */
function rig(script: ReadonlyArray<readonly Row[] | Error>) {
  const calls: Call[] = [];
  const configs: Record<string, unknown>[] = [];
  const errors: (() => void)[] = [];
  let ended = 0;
  let released = 0;
  let next = 0;
  const answer = (): Promise<PlanQueryResult> => {
    const step = script[next++];
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve({ rows: step ?? [], rowCount: (step ?? []).length });
  };
  const client: PlanClient = {
    query: (text, values) => (calls.push({ text, values, on: 'client' }), text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK' ? Promise.resolve({ rows: [], rowCount: null }) : answer()),
    release: () => void (released += 1),
  };
  const pool: PlanPool = {
    query: (text, values) => (calls.push({ text, values, on: 'pool' }), answer()),
    connect: () => Promise.resolve(client),
    end: () => (ended += 1, Promise.resolve()),
    on: (_event, listener) => void errors.push(listener),
  };
  const context: AuditSinkContext = {
    databaseUrl: 'postgres://app.example.test/neburyx',
    poolSize: 9,
    connectionTimeoutMs: 1111,
    statementTimeoutMs: 2222,
    queryTimeoutMs: 3333,
    newId: () => NEW_ID,
    onConnectionError: () => undefined,
  };
  const store = createPlanStore(context, { createPool: (config) => (configs.push({ ...config }), pool) });
  return { store, calls, configs, errors, ended: () => ended, released: () => released, context };
}

const WHEN = new Date('2026-11-13T10:00:00Z');
const ROW: Row = { id: PLAN, user_id: USER, source_id: 'demo', turn_id: null, template_id: 'entity', template_version: 1, params: { entityRef: 'node_a' }, state: 'proposed', parent_plan_id: null, planning_trace_id: 'tr-1', created_at: WHEN, expires_at: WHEN };

describe('the connection of the plan store', () => {
  it('keeps a pool of its own of two connections with the limits of the application login, and reports a connection error through the context', () => {
    const { configs, errors, context } = rig([]);
    expect(PLAN_POOL_SIZE).toBe(2);
    expect(configs).toEqual([{ connectionString: context.databaseUrl, max: 2, connectionTimeoutMillis: 1111, statement_timeout: 2222, query_timeout: 3333 }]);
    expect(errors).toEqual([context.onConnectionError]);
  });

  it('ends its pool once, whatever the number of calls to close', async () => {
    const { store, ended } = rig([]);
    await Promise.all([store.close(), store.close()]);
    await store.close();
    expect(ended()).toBe(1);
  });
});

describe('a failure of the store', () => {
  it.each([
    ['an insert', (store: ReturnType<typeof rig>['store']) => store.insert({ userId: USER, sourceId: 'demo', templateId: 'entity', templateVersion: 1, params: {}, planningTraceId: 'tr-1' })],
    ['a read', (store: ReturnType<typeof rig>['store']) => store.get(PLAN, USER)],
    ['a claim', (store: ReturnType<typeof rig>['store']) => store.claim(PLAN, USER)],
    ['a cancel', (store: ReturnType<typeof rig>['store']) => store.cancel(PLAN, USER)],
    ['an edit', (store: ReturnType<typeof rig>['store']) => store.edit({ planId: PLAN, userId: USER, templateId: 'entity', templateVersion: 1, params: {} })],
    ['a finish', (store: ReturnType<typeof rig>['store']) => store.finish({ planId: PLAN, userId: USER, outcome: 'complete', rowCount: 1, elapsedMs: 1 })],
  ])('says only a fixed code for %s whose statement the database refused, never the driver text', async (_name, call) => {
    const { store } = rig([new Error('duplicate key value violates constraint "secret_params_idx" Key (params)=(secret)'), new Error('second')]);
    const failure = await call(store).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PlanStoreError);
    expect(failure).toMatchObject({ code: 'PLAN_STORE_FAILED', message: 'the plan store could not complete the call' });
    expect(String(failure)).not.toContain('secret');
  });

  it('rolls an edit back and gives its connection back when the insert of the new plan fails', async () => {
    const { store, calls, released } = rig([[{ source_id: 'demo', turn_id: null, planning_trace_id: 'tr-1' }], new Error('boom')]);
    await expect(store.edit({ planId: PLAN, userId: USER, templateId: 'entity', templateVersion: 1, params: {} })).rejects.toBeInstanceOf(PlanStoreError);
    expect(calls.filter((call) => call.on === 'client').map((call) => call.text.split(' ')[0])).toEqual(['BEGIN', 'UPDATE', 'INSERT', 'ROLLBACK']);
    expect(released()).toBe(1);
  });
});

describe('inserting a plan', () => {
  it('stores it as proposed with the expiry taken from the database clock, and no text of a question', async () => {
    const { store, calls } = rig([[ROW]]);
    const stored = await store.insert({ userId: USER, sourceId: 'demo', templateId: 'entity', templateVersion: 1, params: { entityRef: 'node_a' }, planningTraceId: 'tr-1' });
    expect(stored).toEqual({ id: PLAN, userId: USER, sourceId: 'demo', turnId: undefined, templateId: 'entity', templateVersion: 1, params: { entityRef: 'node_a' }, state: 'proposed', parentPlanId: undefined, planningTraceId: 'tr-1', createdAt: WHEN, expiresAt: WHEN });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("'proposed'");
    expect(calls[0]?.text).toContain("clock_timestamp() + interval '15 minutes'");
    expect(calls[0]?.values).toEqual([NEW_ID, USER, 'demo', null, 'entity', 1, '{"entityRef":"node_a"}', null, 'tr-1']);
  });
});

describe('a typed value that a plan holds', () => {
  const REMOVES = /params = (CASE WHEN template_id = 'search' THEN params - 'text' ELSE params END|CASE WHEN plan\.template_id = 'search' THEN plan\.params - 'text' ELSE plan\.params END)/;

  it('is removed in the very statement that claims the plan, which gives back the parameters the plan had', async () => {
    const { store, calls } = rig([[{ ...ROW, state: 'confirmed', params: { entityTypes: ['node_a'], text: 'ref 77' } }]]);
    const result = await store.claim(PLAN, USER);
    expect(result).toMatchObject({ status: 'claimed', plan: { params: { entityTypes: ['node_a'], text: 'ref 77' } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toMatch(REMOVES);
    expect(calls[0]?.text).toContain('target.params AS params');
    expect(calls[0]?.text).toContain('FOR UPDATE');
  });

  it.each([
    ['a cancel', async (store: ReturnType<typeof rig>['store']) => store.cancel(PLAN, USER), [[{ id: PLAN }]], 0],
    ['an edit, for the old plan', async (store: ReturnType<typeof rig>['store']) => store.edit({ planId: PLAN, userId: USER, templateId: 'entity', templateVersion: 1, params: {} }), [[{ source_id: 'demo', turn_id: null, planning_trace_id: 'tr-1' }], [ROW]], 1],
  ])('is removed in the statement of %s that moves the plan out of proposed', async (_name, call, script, index) => {
    const { store, calls } = rig(script as never);
    await call(store);
    expect(calls[index]?.text).toMatch(REMOVES);
  });

  it('is removed in the statement that marks a plan expired when it is read, which is only a change of state and scrub of that plan', async () => {
    const { store, calls } = rig([[], [{ state: 'proposed', past: true }], []]);
    await store.claim(PLAN, USER);
    expect(calls[2]?.text).toMatch(REMOVES);
    expect(calls[2]?.text).toMatch(/SET state = 'expired'/);
  });

  it('is not part of the insert of a new plan beyond the parameters the caller gives it', async () => {
    const { store, calls } = rig([[ROW]]);
    await store.insert({ userId: USER, sourceId: 'demo', templateId: 'search', templateVersion: 1, params: { entityTypes: ['node_a'], text: 'ref 77' }, planningTraceId: 'tr-1' });
    expect(calls[0]?.values?.[6]).toBe('{"entityTypes":["node_a"],"text":"ref 77"}');
    expect(calls[0]?.text).not.toMatch(REMOVES);
  });
});

describe('the sweep of plans that expired unread', () => {
  it('marks them expired and removes the typed value, oldest first, at most the limit, skipping the rows another call holds, and says how many it cleared', async () => {
    const { store, calls } = rig([[{ id: 'a' }, { id: 'b' }]]);
    expect(await store.sweep(500)).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/SET state = 'expired', params = CASE WHEN template_id = 'search' THEN params - 'text' ELSE params END/);
    expect(calls[0]?.text).toMatch(/state = 'proposed' AND expires_at <= clock_timestamp\(\) ORDER BY expires_at LIMIT \$1 FOR UPDATE SKIP LOCKED/);
    expect(calls[0]?.values).toEqual([500]);
  });

  it('clears nothing when nothing expired, and says so', async () => {
    const { store } = rig([[]]);
    expect(await store.sweep(500)).toBe(0);
  });

  it('says only a fixed code when the statement is refused', async () => {
    const { store } = rig([new Error('deadlock detected, key (params)=(secret)')]);
    const failure = await store.sweep(500).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlanStoreError);
    expect(String(failure)).not.toContain('secret');
  });
});

describe('reading a plan', () => {
  it('reads a plan of the caller whatever its state, from one statement that names the owner', async () => {
    const { store, calls } = rig([[{ ...ROW, state: 'cancelled' }]]);
    expect(await store.get(PLAN, USER)).toMatchObject({ id: PLAN, state: 'cancelled', userId: USER });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/WHERE id = \$1 AND user_id = \$2/);
    expect(calls[0]?.values).toEqual([PLAN, USER]);
  });

  it('answers undefined for a plan that is not there or is another user\u2019s', async () => {
    const { store } = rig([[]]);
    expect(await store.get(PLAN, USER)).toBeUndefined();
  });
});

describe('claiming a plan', () => {
  it('moves a proposed plan of the caller to confirmed in one statement and gives it back', async () => {
    const { store, calls } = rig([[{ ...ROW, state: 'confirmed' }]]);
    const result = await store.claim(PLAN, USER);
    expect(result).toMatchObject({ status: 'claimed', plan: { id: PLAN, state: 'confirmed' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/state = 'proposed' AND expires_at > clock_timestamp\(\)[\s\S]*SET state = 'confirmed'/);
    expect(calls[0]?.values).toEqual([PLAN, USER]);
  });

  it.each([
    ['a plan that is not there or is another user’s', [], 'absent'],
    ['a plan that was claimed', [{ state: 'confirmed', past: false }], 'not-runnable'],
    ['a plan that ran', [{ state: 'run', past: true }], 'not-runnable'],
    ['a plan that was cancelled', [{ state: 'cancelled', past: false }], 'not-runnable'],
    ['a plan that was marked expired', [{ state: 'expired', past: true }], 'expired'],
  ] as const)('answers %s with %s and changes nothing', async (_name, found, status) => {
    const { store, calls } = rig([[], found]);
    expect(await store.claim(PLAN, USER)).toEqual({ status });
    expect(calls.map((call) => call.text.split(' ')[0])).toEqual(['WITH', 'SELECT']);
  });

  it('marks a proposed plan that is past its time as expired and answers expired', async () => {
    const { store, calls } = rig([[], [{ state: 'proposed', past: true }], []]);
    expect(await store.claim(PLAN, USER)).toEqual({ status: 'expired' });
    expect(calls.map((call) => call.text.split(' ')[0])).toEqual(['WITH', 'SELECT', 'UPDATE']);
    expect(calls[2]?.text).toMatch(/SET state = 'expired'[\s\S]*state = 'proposed'[\s\S]*expires_at <= clock_timestamp\(\)/);
  });

  it('answers not-runnable for a plan that was taken by another claim between the statements', async () => {
    const { store } = rig([[], [{ state: 'confirmed', past: false }]]);
    expect(await store.claim(PLAN, USER)).toEqual({ status: 'not-runnable' });
  });
});

describe('cancelling a plan', () => {
  it('cancels a proposed plan of the caller that has not expired', async () => {
    const { store, calls } = rig([[{ id: PLAN }]]);
    expect(await store.cancel(PLAN, USER)).toEqual({ status: 'cancelled' });
    expect(calls[0]?.text).toMatch(/SET state = 'cancelled'[\s\S]*state = 'proposed'[\s\S]*expires_at > clock_timestamp\(\)/);
  });

  it.each([
    ['absent', [], 'absent'],
    ['confirmed', [{ state: 'confirmed', past: false }], 'not-runnable'],
    ['already cancelled', [{ state: 'cancelled', past: false }], 'not-runnable'],
    ['expired', [{ state: 'expired', past: true }], 'expired'],
  ] as const)('answers %s plan with %s and changes nothing', async (_name, found, status) => {
    const { store } = rig([[], found]);
    expect(await store.cancel(PLAN, USER)).toEqual({ status });
  });
});

describe('editing a plan', () => {
  it('cancels the old plan and inserts the new one with the old as its parent, in one transaction, keeping the source and the planning trace', async () => {
    const { store, calls, released } = rig([[{ source_id: 'demo', turn_id: null, planning_trace_id: 'tr-1' }], [{ ...ROW, parent_plan_id: PLAN }]]);
    const result = await store.edit({ planId: PLAN, userId: USER, templateId: 'expand', templateVersion: 2, params: { hops: 1 } });
    expect(result).toMatchObject({ status: 'edited', plan: { parentPlanId: PLAN, state: 'proposed' } });
    expect(calls.map((call) => `${call.on}:${call.text.split(' ')[0]}`)).toEqual(['client:BEGIN', 'client:UPDATE', 'client:INSERT', 'client:COMMIT']);
    expect(calls[1]?.text).toMatch(/SET state = 'cancelled'[\s\S]*state = 'proposed'[\s\S]*expires_at > clock_timestamp\(\)/);
    expect(calls[2]?.values).toEqual([NEW_ID, USER, 'demo', null, 'expand', 2, '{"hops":1}', PLAN, 'tr-1']);
    expect(released()).toBe(1);
  });

  it.each([
    ['absent', [], 'absent'],
    ['confirmed', [{ state: 'confirmed', past: false }], 'not-runnable'],
    ['expired', [{ state: 'expired', past: true }], 'expired'],
  ] as const)('inserts nothing for a plan that is %s, and answers %s', async (_name, found, status) => {
    const { store, calls } = rig([[], found]);
    expect(await store.edit({ planId: PLAN, userId: USER, templateId: 'entity', templateVersion: 1, params: {} })).toEqual({ status });
    expect(calls.some((call) => call.text.startsWith('INSERT'))).toBe(false);
  });
});

describe('finishing a run', () => {
  it('makes the claimed plan run and writes one run row, in one transaction', async () => {
    const { store, calls } = rig([[{ id: PLAN }], []]);
    expect(await store.finish({ planId: PLAN, userId: USER, outcome: 'partial', rowCount: 7, elapsedMs: 120 })).toEqual({ status: 'finished', runId: NEW_ID });
    expect(calls.map((call) => call.text.split(' ')[0])).toEqual(['BEGIN', 'UPDATE', 'INSERT', 'COMMIT']);
    expect(calls[1]?.text).toMatch(/SET state = 'run'[\s\S]*state = 'confirmed'/);
    expect(calls[2]?.values).toEqual([NEW_ID, PLAN, USER, 'partial', 7, 120]);
  });

  it('writes no run row for a plan that is not confirmed, and says so', async () => {
    const { store, calls } = rig([[]]);
    expect(await store.finish({ planId: PLAN, userId: USER, outcome: 'complete', rowCount: 1, elapsedMs: 1 })).toEqual({ status: 'not-runnable' });
    expect(calls.some((call) => call.text.startsWith('INSERT'))).toBe(false);
  });
});
