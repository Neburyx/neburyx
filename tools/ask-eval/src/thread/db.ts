import { readFileSync } from 'node:fs';
import pg from 'pg';
import { UsageError } from '../questions.js';
import type { Db } from './records.js';

/** The one name read from the env file of the product's own test database: the application login's URL. Nothing else in the file is read or printed. */
const URL_NAME = 'NEBURYX_DEV_DATABASE_URL';

/** A read-only connection to the run's own test database, from the env file the dev tool already uses, passed by path. The connection string is never printed. */
export async function connectDb(envFile: string): Promise<{ readonly db: Db; readonly close: () => Promise<void> }> {
  let url: string | undefined;
  try {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const trimmed = line.trim().replace(/^export\s+/u, '');
      if (trimmed.startsWith(`${URL_NAME}=`)) url = trimmed.slice(URL_NAME.length + 1).trim().replace(/^["']|["']$/gu, '');
    }
  } catch {
    throw new UsageError('the database env file cannot be read');
  }
  if (url === undefined || url === '') throw new UsageError('the database env file has no application database setting');
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000, statement_timeout: 20000 });
  try {
    await client.connect();
  } catch {
    throw new UsageError('the database cannot be reached');
  }
  await client.query('SET default_transaction_read_only = on');
  const query: Db['query'] = async (text, values) => {
    const result = await client.query(text, [...values]);
    const rows: Record<string, unknown>[] = result.rows;
    return { rows };
  };
  return { db: { query }, close: () => client.end() };
}
