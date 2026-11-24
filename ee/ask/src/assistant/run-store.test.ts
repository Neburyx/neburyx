import type { AuditSinkContext } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createMemoryAssistantRunStore, createPgAssistantRunStore, AssistantRunGuardError, AssistantRunStoreError, type AssistantPool } from './run-store.js';

const NEW_ID = '01939999-0000-7000-8000-000000000001';
const ACTOR = '01939999-0000-7000-8000-0000000000aa';
const INVESTIGATION = '01939999-0000-7000-8000-0000000000bb';
const AT = new Date('2026-11-15T10:00:00Z');

const CONTEXT: AuditSinkContext = {
  databaseUrl: 'postgres://app.example.test/neburyx',
  poolSize: 5,
  connectionTimeoutMs: 1111,
  statementTimeoutMs: 2222,
  queryTimeoutMs: 3333,
  newId: () => NEW_ID,
  onConnectionError: () => undefined,
};

interface Guard {
  /** No row for the run. */
  readonly missing?: boolean;
  readonly investigationId?: string | null;
  /** The count the run holds; null when its turn could not read one. */
  readonly runEpoch?: number | null;
  readonly current?: number;
  /** No row of the investigation to lock. */
  readonly noInvestigation?: boolean;
  /** The statement of the guard that fails. */
  readonly failAt?: RegExp;
}

function rig(failure?: Error, rowCount = 1, guard: Guard = {}) {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const configs: Record<string, unknown>[] = [];
  const errors: (() => void)[] = [];
  let ended = 0;
  let released = 0;
  const client = {
    query: async (text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      if (failure !== undefined) throw failure;
      if (guard.failAt?.test(text) === true) throw new Error('DRIVER-TEXT canary');
      if (/FROM assistant_runs WHERE id/.test(text)) return { rows: guard.missing === true ? [] : [{ actor_id: ACTOR, investigation_id: guard.investigationId === undefined ? INVESTIGATION : guard.investigationId, thread_epoch: guard.runEpoch === undefined ? 4 : guard.runEpoch }] };
      if (/FOR SHARE/.test(text)) return { rows: guard.noInvestigation === true ? [] : [{ '?column?': 1 }] };
      if (/AS epoch/.test(text)) return { rows: [{ epoch: guard.current === undefined ? 4 : guard.current }] };
      return { rowCount, rows: [] };
    },
    release: () => void (released += 1),
  };
  const pool: AssistantPool = {
    query: (text, values) => (failure === undefined ? (calls.push({ text, values }), Promise.resolve({ rowCount })) : Promise.reject(failure)),
    connect: () => Promise.resolve(client),
    end: () => (ended += 1, Promise.resolve()),
    on: (_event, listener) => void errors.push(listener),
  };
  const store = createPgAssistantRunStore(CONTEXT, { createPool: (config) => (configs.push({ ...config }), pool) });
  /** The statements that write a run or a call, without the guard's reads and the transaction's own. */
  const writes = (): { text: string; values: readonly unknown[] }[] => calls.filter((call) => /^(INSERT|UPDATE|DELETE)/.test(call.text));
  return { store, calls, writes, configs, errors, ended: () => ended, released: () => released };
}

describe('the pg assistant run store', () => {
  it('keeps a pool of two with the timeouts of the context, and reports a connection error through it', () => {
    const { configs, errors } = rig();
    expect(configs).toEqual([{ connectionString: CONTEXT.databaseUrl, max: 2, connectionTimeoutMillis: 1111, statement_timeout: 2222, query_timeout: 3333 }]);
    expect(errors).toEqual([CONTEXT.onConnectionError]);
  });

  it('writes the run row with the id it carries, and none for an id it already holds', async () => {
    const { store, calls } = rig();
    await store.begin({ id: NEW_ID, actorId: ACTOR, investigationId: INVESTIGATION, sourceId: 'demo', traceId: 't1', startedAt: AT, settings: { model: 'm', maxCalls: 5 } });
    expect(calls).toEqual([
      {
        text: 'INSERT INTO assistant_runs (id, actor_id, investigation_id, source_id, trace_id, started_at, settings, thread_epoch) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING',
        values: [NEW_ID, ACTOR, INVESTIGATION, 'demo', 't1', AT, '{"model":"m","maxCalls":5}', null],
      },
    ]);
  });

  it('writes a null investigation where the request names none', async () => {
    const { store, calls } = rig();
    await store.begin({ id: NEW_ID, actorId: ACTOR, sourceId: 'demo', traceId: 't1', startedAt: AT, settings: {} });
    expect(calls[0]?.values[2]).toBeNull();
  });

  it('writes a call before it is made, then its end, then the end of the run', async () => {
    const { store, writes } = rig();
    await store.beginCall({ runId: NEW_ID, number: 1, startedAt: AT, instructionsSha256: 'abc', instructionsText: 'INSTR', valuesText: 'VALUES', toolsOffered: 'answer,view' });
    await store.endCall({ runId: NEW_ID, number: 1, status: 'answered', replyText: 'REPLY', tokensIn: 10, tokensOut: 4, durationMs: 120 });
    await store.endCall({ runId: NEW_ID, number: 2, status: 'failed', failureKind: 'timeout', errorClass: 'AbortError', errorCode: 'ABORT', errorType: 'timeout_error', durationMs: 5 });
    await store.finish(NEW_ID, 'ok', 1, AT);
    const calls = writes();
    expect(calls.map((call) => call.text.split(' ').slice(0, 3).join(' '))).toEqual(['INSERT INTO assistant_run_calls', 'UPDATE assistant_run_calls SET', 'UPDATE assistant_run_calls SET', 'UPDATE assistant_runs SET']);
    expect(calls[0]?.values).toEqual([NEW_ID, 1, AT, 'abc', 'INSTR', 'VALUES', 'answer,view']);
    expect(calls[1]?.values).toEqual([NEW_ID, 1, 'answered', null, 'REPLY', 10, 4, 120, null, null, null]);
    expect(calls[2]?.values).toEqual([NEW_ID, 2, 'failed', 'timeout', null, null, null, 5, 'AbortError', 'ABORT', 'timeout_error']);
    expect(calls[3]?.values).toEqual([NEW_ID, 'ok', 1, AT]);
  });

  it('removes the runs that started before the moment and answers how many', async () => {
    const { store, calls } = rig(undefined, 3);
    expect(await store.removeStartedBefore(AT)).toBe(3);
    expect(calls).toEqual([{ text: 'DELETE FROM assistant_runs WHERE started_at < $1', values: [AT] }]);
  });

  it.each([
    ['begin', (store: ReturnType<typeof rig>['store']) => store.begin({ id: NEW_ID, actorId: ACTOR, sourceId: 's', traceId: 't', startedAt: AT, settings: {} })],
    ['beginCall', (store: ReturnType<typeof rig>['store']) => store.beginCall({ runId: NEW_ID, number: 1, startedAt: AT, instructionsSha256: 'a', instructionsText: 'i', valuesText: 'v' })],
    ['endCall', (store: ReturnType<typeof rig>['store']) => store.endCall({ runId: NEW_ID, number: 1, status: 'answered', durationMs: 1 })],
    ['finish', (store: ReturnType<typeof rig>['store']) => store.finish(NEW_ID, 'ok', 1, AT)],
    ['removeStartedBefore', (store: ReturnType<typeof rig>['store']) => store.removeStartedBefore(AT)],
  ])('throws a fixed error that holds nothing of the driver or the row when %s fails', async (_name, run) => {
    const { store } = rig(new Error(`insert into assistant_run_calls failed for ${ACTOR}: password authentication failed; values_text=SECRET VALUES`));
    const failure: unknown = await run(store).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AssistantRunStoreError);
    expect(failure).toMatchObject({ code: 'ASSISTANT_RUN_WRITE_FAILED', message: 'the record of an assistant turn could not be written' });
    expect(String((failure as Error).message)).not.toMatch(/password|summary_run|SECRET|actor/);
  });

  it.each([
    ['endCall', (store: ReturnType<typeof rig>['store']) => store.endCall({ runId: NEW_ID, number: 1, status: 'answered', durationMs: 1 })],
    ['finish', (store: ReturnType<typeof rig>['store']) => store.finish(NEW_ID, 'ok', 1, AT)],
  ])('throws the fixed error when %s changed no row', async (_name, run) => {
    const { store } = rig(undefined, 0);
    await expect(run(store)).rejects.toBeInstanceOf(AssistantRunStoreError);
  });

  it('ends the pool once, however often it is closed', async () => {
    const { store, ended } = rig();
    await store.close();
    await store.close();
    expect(ended()).toBe(1);
  });
});

describe('the memory assistant run store', () => {
  it('keeps the records and removes by the start, keeping a run that started at the moment', async () => {
    const store = createMemoryAssistantRunStore();
    const old = '00000000-0000-7000-8000-000000000001';
    const equal = '00000000-0000-7000-8000-000000000002';
    await store.begin({ id: old, actorId: ACTOR, sourceId: 's', traceId: 't', startedAt: new Date(AT.getTime() - 1), settings: {} });
    await store.begin({ id: equal, actorId: ACTOR, sourceId: 's', traceId: 't', startedAt: AT, settings: {} });
    expect(await store.removeStartedBefore(AT)).toBe(1);
    expect(store.runs.map((run) => run.id)).toEqual([equal]);
    expect(store.runs.map((run) => run.id)).not.toContain(old);
  });

  it('fails at the step it is told to', async () => {
    const store = createMemoryAssistantRunStore({ failOn: 'finish' });
    const id = '00000000-0000-7000-8000-000000000001';
    await store.begin({ id, actorId: ACTOR, sourceId: 's', traceId: 't', startedAt: AT, settings: {} });
    await expect(store.finish(id, 'ok', 1, AT)).rejects.toBeInstanceOf(AssistantRunStoreError);
  });
});

describe('the memory store of the assistant turns', () => {
  const START = { id: 'run-1', actorId: 'a', sourceId: 's', traceId: 't', startedAt: new Date(0), settings: {} };
  const CALL = { runId: 'run-1', number: 1, startedAt: new Date(0), instructionsSha256: 'a'.repeat(64), instructionsText: 'I', valuesText: 'V' };

  it('keeps one row for a call start written twice, as the database does', async () => {
    const store = createMemoryAssistantRunStore();
    await store.begin(START);
    await store.beginCall(CALL);
    await store.beginCall(CALL);
    expect(store.runs[0]?.callStarts).toHaveLength(1);
  });

  it('refuses the end of a call that was never started, and of a run that does not exist, with the fixed error', async () => {
    const store = createMemoryAssistantRunStore();
    await store.begin(START);
    await expect(store.endCall({ runId: 'run-1', number: 1, status: 'answered', durationMs: 1 })).rejects.toBeInstanceOf(AssistantRunStoreError);
    await expect(store.endCall({ runId: 'nope', number: 1, status: 'answered', durationMs: 1 })).rejects.toBeInstanceOf(AssistantRunStoreError);
    await expect(store.finish('nope', 'answered', 0, new Date(0))).rejects.toBeInstanceOf(AssistantRunStoreError);
  });
});

describe('the guard of the text of a call (pg)', () => {
  const START = { runId: NEW_ID, number: 1, startedAt: AT, instructionsSha256: 'abc', instructionsText: 'INSTR', valuesText: 'VALUES' };
  const END = { runId: NEW_ID, number: 1, status: 'answered' as const, replyText: 'REPLY', tokensIn: 10, tokensOut: 4, durationMs: 120 };
  const sequence = (calls: readonly { text: string }[]): string[] => calls.map((call) => call.text.split(' ').slice(0, 2).join(' '));

  it('writes the run row with the count its turn read', async () => {
    const { store, calls } = rig();
    await store.begin({ id: NEW_ID, actorId: ACTOR, investigationId: INVESTIGATION, sourceId: 'demo', traceId: 't1', startedAt: AT, settings: {}, threadEpoch: 4 });
    expect(calls[0]?.values[7]).toBe(4);
  });

  it('checks the count under the lock of the investigation, in one transaction, and writes the text when the run holds the count the thread has', async () => {
    const { store, calls, released } = rig();
    await store.beginCall(START);
    await store.endCall(END);
    expect(sequence(calls)).toEqual(['BEGIN', 'SELECT actor_id,', 'SELECT 1', 'SELECT COALESCE((SELECT', 'INSERT INTO', 'COMMIT', 'BEGIN', 'SELECT actor_id,', 'SELECT 1', 'SELECT COALESCE((SELECT', 'UPDATE assistant_run_calls', 'COMMIT']);
    expect(calls[2]?.text).toContain('FOR SHARE');
    expect(calls[2]?.values).toEqual([INVESTIGATION]);
    expect(calls[3]?.values).toEqual([INVESTIGATION, ACTOR]);
    expect(calls[4]?.values[5]).toBe('VALUES');
    expect(calls[10]?.values[4]).toBe('REPLY');
    expect(released()).toBe(2);
  });

  it.each([
    ['the count has moved since the turn began', { current: 5 }],
    ['the run holds no count', { runEpoch: null }],
    ['there is no row of the run', { missing: true }],
    ['there is no row of the investigation', { noInvestigation: true }],
  ] as const)('writes the call without its text when %s, and keeps the rest of the call', async (_name, guard) => {
    const { store, writes, calls } = rig(undefined, 1, guard);
    await store.beginCall(START);
    await store.endCall(END);
    expect(writes()[0]?.values[5]).toBe('');
    expect(writes()[1]?.values).toEqual([NEW_ID, 1, 'answered', null, null, 10, 4, 120, null, null, null]);
    expect(calls.filter((call) => call.text === 'COMMIT')).toHaveLength(2);
  });

  it('writes the text of a run that names no investigation, with no lock', async () => {
    const { store, calls, writes } = rig(undefined, 1, { investigationId: null });
    await store.beginCall(START);
    expect(writes()[0]?.values[5]).toBe('VALUES');
    expect(calls.some((call) => /FOR SHARE/.test(call.text))).toBe(false);
  });

  it.each([/FROM assistant_runs WHERE id/, /FOR SHARE/, /AS epoch/])('writes the call without its text, in a statement of its own, when the guard cannot be read (%s)', async (failAt) => {
    const { store, calls, released } = rig(undefined, 1, { failAt });
    await expect(store.beginCall(START)).rejects.toBeInstanceOf(AssistantRunGuardError);
    await expect(store.endCall(END)).rejects.toBeInstanceOf(AssistantRunGuardError);
    expect(calls.filter((call) => call.text === 'ROLLBACK')).toHaveLength(2);
    expect(calls.filter((call) => call.text === 'COMMIT')).toHaveLength(0);
    const writes = calls.filter((call) => /^(INSERT|UPDATE)/.test(call.text));
    expect(writes[0]?.values[5]).toBe('');
    expect(writes[1]?.values[4]).toBeNull();
    expect(JSON.stringify(calls)).not.toContain('VALUES"');
    expect(JSON.stringify(calls)).not.toContain('REPLY');
    expect(released()).toBe(2);
  });

  it('answers the fixed error and rolls back when the write itself fails after the guard held, and does not try again with the text', async () => {
    const { store, calls, released } = rig(undefined, 0);
    await expect(store.endCall(END)).rejects.toBeInstanceOf(AssistantRunStoreError);
    expect(calls.at(-1)?.text).toBe('ROLLBACK');
    expect(calls.filter((call) => /^UPDATE/.test(call.text))).toHaveLength(1);
    expect(released()).toBe(1);
  });
});
