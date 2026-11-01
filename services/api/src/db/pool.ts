import pg from 'pg';

const POOL_SIZE = 5;
export const CONNECTION_TIMEOUT_MS = 10_000;

export function createPool(url: string, onConnectionError: () => void, connectionTimeoutMs: number = CONNECTION_TIMEOUT_MS): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max: POOL_SIZE, connectionTimeoutMillis: connectionTimeoutMs });
  pool.on('error', onConnectionError);
  pool.on('connect', (client) => client.on('error', onConnectionError));
  return pool;
}
