import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCli } from '../testing/cli.js';
import { fixtureFolder, removeFixtureFolders, rows, runInProcess, waiters } from '../testing/database.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';
import { RUN_LOCK_ID } from './run.js';

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
  removeFixtureFolders();
});

async function holdRunLock(url: string): Promise<pg.Client> {
  const holder = new pg.Client({ connectionString: url });
  await holder.connect();
  await holder.query(`SELECT pg_advisory_lock(${RUN_LOCK_ID})`);
  return holder;
}

describe('two migrate processes started together', () => {
  it('both wait for the run lock, then leave each migration recorded once', async () => {
    const database = await postgres.newDatabase();
    const holder = await holdRunLock(database.ownerUrl);
    try {
      const env = { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };
      const first = runCli(['migrate'], env);
      const second = runCli(['migrate'], env);

      await vi.waitFor(async () => expect(await waiters(database.ownerUrl, RUN_LOCK_ID)).toHaveLength(2), {
        timeout: 60_000,
        interval: 100,
      });

      await holder.query(`SELECT pg_advisory_unlock(${RUN_LOCK_ID})`);
      const results = await Promise.all([first.done, second.done]);

      expect(results.map((result) => result.code)).toEqual([0, 0]);
      expect(results.filter((result) => result.stdout.includes('applied 0001-baseline'))).toHaveLength(1);
      expect(results.filter((result) => result.stdout.includes('nothing to apply'))).toHaveLength(1);
      const check = new pg.Client({ connectionString: database.ownerUrl });
      await check.connect();
      try {
        expect((await check.query('SELECT name FROM kysely_migration ORDER BY name')).rows).toEqual([
          { name: '0001-baseline' },
          { name: '0002-deployment-and-users' },
          { name: '0003-applied-migrations-function' },
        ]);
        const queue = await check.query('SELECT id FROM graphile_worker.migrations');
        expect(new Set(queue.rows.map((row: { id: number }) => row.id)).size).toBe(queue.rows.length);
      } finally {
        await check.end();
      }
    } finally {
      await holder.end();
    }
  });
});

describe('a migrate process whose connection is cut while it waits', () => {
  it('exits 1 with the plain message and prints no connection detail', async () => {
    const database = await postgres.newDatabase();
    const holder = await holdRunLock(database.ownerUrl);
    try {
      const env = { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };
      const run = runCli(['migrate'], env);
      let pid = 0;
      await vi.waitFor(
        async () => {
          const found = await waiters(database.ownerUrl, RUN_LOCK_ID);
          expect(found).toHaveLength(1);
          pid = found[0] ?? 0;
        },
        { timeout: 60_000, interval: 100 },
      );
      await holder.query('SELECT pg_terminate_backend($1)', [pid]);

      const result = await run.done;
      expect(result.code).toBe(1);
      expect(result.stderr).toBe('the database could not be reached\n');
      expect(result.stdout).toBe('');
    } finally {
      await holder.end();
    }
  });
});

async function backendRunning(url: string, fragment: string, waitingOnLock: boolean): Promise<number> {
  const condition = waitingOnLock ? "AND wait_event_type = 'Lock'" : '';
  let pid = 0;
  await vi.waitFor(
    async () => {
      const found = await rows(
        url,
        `SELECT pid::int AS pid FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid() AND query LIKE '%${fragment}%' ${condition}`,
      );
      expect(found).toHaveLength(1);
      pid = Number(found[0]?.['pid']);
    },
    { timeout: 60_000, interval: 100 },
  );
  return pid;
}

describe('a migrate process whose connection is cut while it works', () => {
  it('reports the database as unreachable, not a failed migration, when the cut ends a migration', async () => {
    const database = await postgres.newDatabase();
    const directory = fixtureFolder({ '0001-slow.sql': 'SELECT pg_sleep(120);' });
    const env = { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };
    const run = runInProcess(env, directory);
    const pid = await backendRunning(database.ownerUrl, 'pg_sleep(120)', false);
    await rows(database.ownerUrl, `SELECT pg_terminate_backend(${pid})`);

    const result = await run;
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('the database could not be reached\n');
  });

  it('reports the database as unreachable, not a failed job queue step, when the cut ends the grants', async () => {
    const database = await postgres.newDatabase();
    const directory = fixtureFolder({ '0001-items.sql': 'CREATE TABLE items (id serial PRIMARY KEY);' });
    const env = { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };
    expect((await runInProcess(env, directory)).code).toBe(0);

    const holder = new pg.Client({ connectionString: database.ownerUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`REVOKE ALL ON TABLE graphile_worker._private_tasks FROM ${holder.escapeIdentifier(database.appRole)}`);
      const run = runInProcess(env, directory);
      const pid = await backendRunning(database.ownerUrl, '_private_tasks', true);
      await rows(database.ownerUrl, `SELECT pg_terminate_backend(${pid})`);

      const result = await run;
      expect(result.code).toBe(1);
      expect(result.stderr).toBe('the database could not be reached\n');
    } finally {
      await holder.end();
    }
  });
});
