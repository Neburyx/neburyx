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

async function appliedState(pool: pg.Pool, listing: string, shipped: readonly string[]): Promise<ReadyChecks['migrations']> {
  try {
    const result = await pool.query<{ name: string }>(`SELECT ${listing} AS name`);
    return migrationsState(shipped, result.rows.map((row) => row.name));
  } catch (error) {
    return errorCode(error) === UNDEFINED_FUNCTION ? 'pending' : 'unknown';
  }
}

/** Whether every shipped migration is applied: the product's, and with the preview on the preview's own, which have a history table of their own. */
export async function checkMigrations(pool: pg.Pool, shipped: readonly string[], shippedPreview?: readonly string[]): Promise<ReadyChecks['migrations']> {
  const states = [await appliedState(pool, 'public.applied_migrations()', shipped)];
  if (shippedPreview !== undefined) states.push(await appliedState(pool, 'public.applied_preview_migrations()', shippedPreview));
  if (states.includes('pending')) return 'pending';
  return states.includes('unknown') ? 'unknown' : 'ok';
}
