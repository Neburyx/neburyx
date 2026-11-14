import type { AuditSinkContext } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createPgRunStore, RunStoreError, type RunPool } from './pg-run-store.js';

const NEW_ID = '01939999-0000-7000-8000-000000000001';
const ACTOR = '01939999-0000-7000-8000-0000000000aa';

const CONTEXT: AuditSinkContext = {
  databaseUrl: 'postgres://app.example.test/neburyx',
  poolSize: 5,
  connectionTimeoutMs: 1111,
  statementTimeoutMs: 2222,
  queryTimeoutMs: 3333,
  newId: () => NEW_ID,
  onConnectionError: () => undefined,
};

function rig(failure?: Error) {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const configs: Record<string, unknown>[] = [];
  const errors: (() => void)[] = [];
  let ended = 0;
  const pool: RunPool = {
    query: (text, values) => (failure === undefined ? (calls.push({ text, values }), Promise.resolve()) : Promise.reject(failure)),
    end: () => (ended += 1, Promise.resolve()),
    on: (_event, listener) => void errors.push(listener),
  };
  const store = createPgRunStore(CONTEXT, { createPool: (config) => (configs.push({ ...config }), pool) });
  return { store, calls, configs, errors, ended: () => ended };
}

describe('the pg run store', () => {
  it('keeps a pool of two with the timeouts of the context, and reports a connection error through it', () => {
    const { configs, errors } = rig();
    expect(configs).toEqual([{ connectionString: CONTEXT.databaseUrl, max: 2, connectionTimeoutMillis: 1111, statement_timeout: 2222, query_timeout: 3333 }]);
    expect(errors).toEqual([CONTEXT.onConnectionError]);
  });

  it('inserts one row with a new id, the actor, the intent, the outcome, the count and the time', async () => {
    const { store, calls } = rig();
    await store.record({ actorId: ACTOR, intent: 'entity', outcome: 'partial', rowCount: 4, elapsedMs: 150 });
    expect(calls).toEqual([{ text: 'INSERT INTO ask_runs (id, actor_id, intent, outcome, row_count, elapsed_ms) VALUES ($1, $2, $3, $4, $5, $6)', values: [NEW_ID, ACTOR, 'entity', 'partial', 4, 150] }]);
  });

  it('throws a fixed error that holds nothing of the driver on a failure', async () => {
    const { store } = rig(new Error(`insert into ask_runs failed for actor ${ACTOR}: password authentication failed`));
    const failure: unknown = await store.record({ actorId: ACTOR, intent: 'entity', outcome: 'complete', rowCount: 1, elapsedMs: 1 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunStoreError);
    expect(failure).toMatchObject({ code: 'RUN_WRITE_FAILED', message: 'the Ask run could not be written' });
    expect(String((failure as Error).message)).not.toMatch(/password|ask_runs|actor/);
  });

  it('ends the pool once, however often it is closed', async () => {
    const { store, ended } = rig();
    await store.close();
    await store.close();
    expect(ended()).toBe(1);
  });
});
