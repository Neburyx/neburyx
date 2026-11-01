import type { ReadyChecks } from '@neburyx/contracts';
import type pg from 'pg';
import { errorCode } from '../database-errors.js';

const UNDEFINED_FUNCTION = '42883';

export async function pingDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}

export function migrationsState(shipped: readonly string[], applied: readonly string[]): ReadyChecks['migrations'] {
  const done = new Set(applied);
  return shipped.every((name) => done.has(name)) ? 'ok' : 'pending';
}

export async function checkMigrations(pool: pg.Pool, shipped: readonly string[]): Promise<ReadyChecks['migrations']> {
  try {
    const result = await pool.query<{ name: string }>('SELECT public.applied_migrations() AS name');
    return migrationsState(shipped, result.rows.map((row) => row.name));
  } catch (error) {
    return errorCode(error) === UNDEFINED_FUNCTION ? 'pending' : 'unknown';
  }
}
