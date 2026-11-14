import type { AuditSinkContext } from '@neburyx/contracts';
import pg from 'pg';
import type { RunRecord, RunStore } from './run-store.js';

/** The size of the pool the store keeps of its own: a run is one short insert. */
const RUN_POOL_SIZE = 2;

const INSERT = 'INSERT INTO ask_runs (id, actor_id, intent, outcome, row_count, elapsed_ms) VALUES ($1, $2, $3, $4, $5, $6)';

/** What a failed write says: a fixed message, never the driver's text, the statement or a value. */
export class RunStoreError extends Error {
  readonly code = 'RUN_WRITE_FAILED';

  constructor() {
    super('the Ask run could not be written');
    this.name = 'RunStoreError';
  }
}

/** The part of a connection pool the store uses, so a test can stand in for it. */
export interface RunPool {
  query(text: string, values: readonly unknown[]): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): unknown;
}

export interface RunStoreDeps {
  readonly createPool: (config: pg.PoolConfig) => RunPool;
}

const defaultDeps: RunStoreDeps = { createPool: (config) => new pg.Pool(config) };

/** Records each Ask run in `ask_runs` through the application's own database login, on a pool of its own; it holds no question and no value. */
export function createPgRunStore(context: AuditSinkContext, deps: RunStoreDeps = defaultDeps): RunStore & { close(): Promise<void> } {
  const pool = deps.createPool({
    connectionString: context.databaseUrl,
    max: RUN_POOL_SIZE,
    ...(context.connectionStream === undefined ? {} : { stream: context.connectionStream }),
    connectionTimeoutMillis: context.connectionTimeoutMs,
    statement_timeout: context.statementTimeoutMs,
    query_timeout: context.queryTimeoutMs,
  });
  pool.on('error', context.onConnectionError);
  let closing: Promise<void> | undefined;

  return {
    async record(run: RunRecord) {
      try {
        await pool.query(INSERT, [context.newId(), run.actorId, run.intent, run.outcome, run.rowCount, run.elapsedMs]);
      } catch {
        // the driver's error can hold the failing row, so only a fixed error leaves the store
        throw new RunStoreError();
      }
    },
    close: () => (closing ??= pool.end()),
  };
}
