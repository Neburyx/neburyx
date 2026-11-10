import pg from 'pg';
import { expect, vi } from 'vitest';
import type { TestDatabase } from './postgres.js';

export interface HeldRow {
  /** How many sessions of the database wait for a lock, counted by a superuser connection (which can see the app role's sessions). */
  waiting(): Promise<number>;
  /** Waits until at least `count` sessions wait for a lock. */
  untilWaiting(count: number): Promise<void>;
  release(): Promise<void>;
}

/** Holds the investigation's row in a transaction of its own, so a writer that needs the row waits for it. */
export async function holdRow(database: TestDatabase, investigationId: string): Promise<HeldRow> {
  const holder = new pg.Client({ connectionString: database.ownerUrl });
  const monitor = new pg.Client({ connectionString: database.adminUrl });
  await Promise.all([holder.connect(), monitor.connect()]);
  await holder.query('BEGIN');
  await holder.query(`SELECT 1 FROM investigations WHERE id = $1 FOR UPDATE`, [investigationId]);
  const waiting = async (): Promise<number> => Number((await monitor.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0]?.n);
  return {
    waiting,
    untilWaiting: (count) => vi.waitFor(async () => expect(await waiting()).toBeGreaterThanOrEqual(count), { timeout: 10_000, interval: 25 }),
    release: async () => {
      await holder.query('COMMIT');
      await Promise.all([holder.end(), monitor.end()]);
    },
  };
}

/**
 * Runs two calls so that the first reaches the database's lock on the investigation before the second does: the row is held, each call is started once the number of waiting sessions has grown, and the row is released when both wait. The waiters are then served in the order they queued, so the order is a fact of the test and not of timing.
 */
export async function inOrder<A, B>(database: TestDatabase, investigationId: string, first: () => Promise<A>, second: () => Promise<B>): Promise<readonly [A, B]> {
  const held = await holdRow(database, investigationId);
  try {
    const firstDone = first();
    await held.untilWaiting(1);
    const secondDone = second();
    await held.untilWaiting(2);
    await held.release();
    return [await firstDone, await secondDone];
  } catch (error) {
    await held.release().catch(() => undefined);
    throw error;
  }
}
