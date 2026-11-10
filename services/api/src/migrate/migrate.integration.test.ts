import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCli } from '../testing/cli.js';
import { attempt, fixtureFolder, removeFixtureFolders, rows, runInProcess, waiters } from '../testing/database.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';

const KYSELY_MIGRATION_LOCK_ID = '3853314791062309107';

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
  removeFixtureFolders();
});

async function snapshot(database: TestDatabase): Promise<string> {
  const tables = await rows(
    database.ownerUrl,
    `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('public', 'graphile_worker') ORDER BY 1, 2`,
  );
  const history = await rows(database.ownerUrl, 'SELECT name FROM kysely_migration ORDER BY name');
  const queue = await rows(database.ownerUrl, 'SELECT id FROM graphile_worker.migrations ORDER BY id');
  const privileges = await rows(
    database.ownerUrl,
    `SELECT n.nspname, c.relname, c.relkind, c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'graphile_worker') AND c.relkind IN ('r', 'S', 'v') ORDER BY 1, 2`,
  );
  const schemas = await rows(database.ownerUrl, `SELECT nspname, nspacl::text AS acl FROM pg_namespace WHERE nspname IN ('public', 'graphile_worker') ORDER BY 1`);
  const policies = await rows(
    database.ownerUrl,
    `SELECT schemaname, tablename, policyname, roles::text AS roles, cmd, qual, with_check FROM pg_policies ORDER BY 1, 2, 3`,
  );
  const defaults = await rows(database.ownerUrl, `SELECT defaclobjtype, defaclacl::text AS acl FROM pg_default_acl ORDER BY 1`);
  return JSON.stringify({ tables, history, queue, privileges, schemas, policies, defaults });
}

describe('a database that cannot be reached', () => {
  it('exits 1 with a message that says so and prints no connection details', async () => {
    const closedPort = 'postgres://secret-user:secret-password@127.0.0.1:1/secret_db';
    const result = await runInProcess({ DATABASE_MIGRATION_URL: closedPort, DATABASE_APP_ROLE: 'any_role' }, fixtureFolder({ '0001-a.sql': 'SELECT 1;' }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('could not be reached');
    for (const detail of ['secret-user', 'secret-password', '127.0.0.1', ':1/', 'secret_db']) {
      expect(result.stderr).not.toContain(detail);
    }
  });
});

describe('a batch with a failing migration', () => {
  it('exits 1, names the file, prints no SQL or data, and applies none of the batch', async () => {
    const database = await postgres.newDatabase();
    const directory = fixtureFolder({
      '0001-first.sql': 'CREATE TABLE first_table (id integer);',
      '0002-second.sql': "INSERT INTO missing_table VALUES ('secret-value');",
    });
    const result = await runInProcess({ DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }, directory);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('0002-second');
    for (const text of ['secret-value', 'missing_table', 'INSERT', 'first_table']) expect(result.stderr).not.toContain(text);
    expect(await rows(database.ownerUrl, `SELECT to_regclass('public.first_table') AS found`)).toEqual([{ found: null }]);
    expect(await rows(database.ownerUrl, 'SELECT name FROM kysely_migration')).toEqual([]);
    expect(await attempt(database.appUrl, 'SELECT * FROM kysely_migration')).toMatch(/permission denied/);
    expect(await attempt(database.appUrl, 'SELECT * FROM kysely_migration_lock')).toMatch(/permission denied/);
  });
});

describe('a migration that is blocked on the migration lock', () => {
  it('keeps the history tables closed to the app role while it waits', async () => {
    const database = await postgres.newDatabase();
    const holder = new pg.Client({ connectionString: database.ownerUrl });
    await holder.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(${KYSELY_MIGRATION_LOCK_ID})`);
      const run = runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole });
      await vi.waitFor(async () => expect(await waiters(database.ownerUrl, KYSELY_MIGRATION_LOCK_ID)).toHaveLength(1), {
        timeout: 60_000,
        interval: 100,
      });
      expect(await attempt(database.appUrl, 'SELECT * FROM kysely_migration')).toMatch(/permission denied/);
      expect(await attempt(database.appUrl, 'SELECT * FROM kysely_migration_lock')).toMatch(/permission denied/);
      await holder.query(`SELECT pg_advisory_unlock(${KYSELY_MIGRATION_LOCK_ID})`);
      expect((await run.done).code).toBe(0);
    } finally {
      await holder.end();
    }
  });
});

describe('a job queue step that fails after the application migrations were applied', () => {
  it('exits 1 with a plain message, keeps what was applied, holds nothing, and a retry applies only the queue', async () => {
    const database = await postgres.newDatabase();
    await rows(database.ownerUrl, 'CREATE SCHEMA graphile_worker');
    await rows(database.ownerUrl, 'CREATE TABLE graphile_worker.migrations (wrong integer)');
    const env = { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };

    const failed = await runCli(['migrate'], env).done;
    expect(failed.code).toBe(1);
    expect(failed.stderr).toBe('the job queue step failed after the application migrations were applied; run the command again\n');
    expect(failed.stdout).toBe('');
    expect(await rows(database.ownerUrl, 'SELECT name FROM kysely_migration ORDER BY name')).toEqual([
      { name: '0001-baseline' },
      { name: '0002-deployment-and-users' },
      { name: '0003-applied-migrations-function' },
      { name: '0004-sources' },
      { name: '0005-source-checks' },
      { name: '0006-source-check-identity' },
      { name: '0007-source-check-config' },
      { name: '0008-investigations' },
      { name: '0009-reference-key' },
      { name: '0010-reference-length' },
      { name: '0011-saved-views-listing' },
      { name: '0012-saved-views-deletion' },
      { name: '0013-exports' },
      { name: '0014-export-idempotency' },
    ]);
    expect(await attempt(database.appUrl, 'SELECT * FROM kysely_migration')).toMatch(/permission denied/);
    await vi.waitFor(
      async () => {
        expect(await rows(database.ownerUrl, `SELECT count(*)::int AS locks FROM pg_locks WHERE locktype = 'advisory'`)).toEqual([{ locks: 0 }]);
        expect(
          await rows(database.ownerUrl, `SELECT count(*)::int AS others FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`),
        ).toEqual([{ others: 0 }]);
      },
      { timeout: 15_000, interval: 100 },
    );

    await rows(database.ownerUrl, 'DROP SCHEMA graphile_worker CASCADE');
    const retried = await runCli(['migrate'], env).done;
    expect(retried.code).toBe(0);
    expect(retried.stdout).toContain('nothing to apply');
    expect(await rows(database.ownerUrl, `SELECT count(*)::int AS n FROM graphile_worker.migrations`)).not.toEqual([{ n: 0 }]);
  });
});

describe('a fresh install with the real migrations', () => {
  it('applies them in order, creates pg_trgm and the job queue schema, and a second run changes nothing', async () => {
    const database = await postgres.newDatabase();
    const env = { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };

    const first = await runCli(['migrate'], env).done;
    expect(first).toMatchObject({ code: 0 });
    expect(first.stdout).toContain('applied 0001-baseline');
    expect(await rows(database.ownerUrl, `SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`)).toEqual([{ extname: 'pg_trgm' }]);
    expect(await rows(database.ownerUrl, `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'graphile_worker'`)).toEqual([
      { schema_name: 'graphile_worker' },
    ]);
    const afterFirst = await snapshot(database);

    const second = await runCli(['migrate'], env).done;
    expect(second).toMatchObject({ code: 0 });
    expect(second.stdout).toContain('nothing to apply');
    expect(await snapshot(database)).toBe(afterFirst);
  });

  it('exits 1 naming the key when the migration URL is missing', async () => {
    const result = await runCli(['migrate'], {}).done;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_MIGRATION_URL');
  });
});
