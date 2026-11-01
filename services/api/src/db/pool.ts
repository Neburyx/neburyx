import pg from 'pg';

const POOL_SIZE = 5;
export const CONNECTION_TIMEOUT_MS = 10_000;

export interface PoolOptions {
  readonly max?: number;
  readonly connectionTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
}

export function createPool(url: string, onConnectionError: () => void, options: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? POOL_SIZE,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS,
    ...(options.statementTimeoutMs === undefined ? {} : { statement_timeout: options.statementTimeoutMs }),
    ...(options.queryTimeoutMs === undefined ? {} : { query_timeout: options.queryTimeoutMs }),
  });
  pool.on('error', onConnectionError);
  pool.on('connect', (client) => client.on('error', onConnectionError));
  return pool;
}
