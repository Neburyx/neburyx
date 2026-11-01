import { rmSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCli } from '../testing/cli.js';
import { rows } from '../testing/database.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { startApi, stopApi, webRoot } from '../testing/start-api.js';

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

async function migrated(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done;
  expect(result.code).toBe(0);
  return database;
}

async function waitingForATransaction(database: TestDatabase): Promise<void> {
  await vi.waitFor(
    async () => {
      const waiting = await rows(
        database.ownerUrl,
        `SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE l.locktype = 'transactionid' AND NOT l.granted AND a.datname = current_database()`,
      );
      expect(waiting).toHaveLength(1);
    },
    { timeout: 30_000, interval: 50 },
  );
}

async function withOpenTransaction(database: TestDatabase, statement: string, whileOpen: () => Promise<void>): Promise<void> {
  const holder = new pg.Client({ connectionString: database.ownerUrl });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(statement);
    await whileOpen();
    await holder.query('COMMIT');
  } finally {
    await holder.end();
  }
}

type Started = Awaited<ReturnType<typeof startApi>>;

async function startWhileHeld(database: TestDatabase, statement: string): Promise<Started> {
  let pending: Promise<Started> | undefined;
  let settled = false;
  try {
    await withOpenTransaction(database, statement, async () => {
      pending = startApi({ DATABASE_URL: database.appUrl }).finally(() => {
        settled = true;
      });
      await waitingForATransaction(database);
      expect(settled).toBe(false);
    });
    if (pending === undefined) throw new Error('the copy was never started');
    return await pending;
  } catch (error) {
    const started = await pending?.catch(() => undefined);
    if (started) await stopApi(started.result);
    throw error;
  }
}

describe('an API copy that starts while another transaction is writing the first rows', () => {
  it('waits for the deployment row and keeps the other transaction’s values', async () => {
    const database = await migrated();
    const started = await startWhileHeld(
      database,
      `INSERT INTO deployment (edition, identity_mode, initialized_at) VALUES ('enterprise', 'sso', '2020-01-01T00:00:00Z')`,
    );
    expect(started.result.exitCode).toBe(0);
    await stopApi(started.result);
    expect(await rows(database.ownerUrl, `SELECT edition, identity_mode, initialized_at::text AS at FROM deployment`)).toEqual([
      { edition: 'enterprise', identity_mode: 'sso', at: '2020-01-01 00:00:00+00' },
    ]);
    expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM users')).toEqual([{ n: 1 }]);
  });

  it('waits for the local user and keeps the other transaction’s id', async () => {
    const database = await migrated();
    const otherId = '0192f000-0000-7000-8000-00000000abcd';
    const started = await startWhileHeld(
      database,
      `INSERT INTO users (id, issuer, subject, display_name, role) VALUES ('${otherId}', 'local', 'local', 'Local workspace', 'administrator')`,
    );
    expect(started.result.exitCode).toBe(0);
    await stopApi(started.result);
    expect(await rows(database.ownerUrl, 'SELECT id FROM users')).toEqual([{ id: otherId }]);
    expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM deployment')).toEqual([{ n: 1 }]);
  });
});

describe('two API copies that start at the same moment', () => {
  it('both start, with no unique-violation error, and leave one row of each', async () => {
    const database = await migrated();
    const copies = await Promise.all([startApi({ DATABASE_URL: database.appUrl }), startApi({ DATABASE_URL: database.appUrl })]);
    expect(copies.map((copy) => copy.result.exitCode)).toEqual([0, 0]);
    expect(copies.map((copy) => copy.stderr)).toEqual(['', '']);
    await Promise.all(copies.map((copy) => stopApi(copy.result)));
    expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM deployment')).toEqual([{ n: 1 }]);
    expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM users')).toEqual([{ n: 1 }]);
  });
});
