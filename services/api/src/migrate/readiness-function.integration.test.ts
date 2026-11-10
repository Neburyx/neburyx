import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../testing/cli.js';
import { attempt, rows } from '../testing/database.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
});

async function migrated(): Promise<{ database: TestDatabase; env: Record<string, string> }> {
  const database = await postgres.newDatabase();
  const env = { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };
  expect((await runCli(['migrate'], env).done).code).toBe(0);
  return { database, env };
}

async function functionState(database: TestDatabase): Promise<string> {
  return JSON.stringify(
    await rows(
      database.ownerUrl,
      `SELECT p.prosecdef, p.proconfig::text AS config, p.proacl::text AS acl, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'applied_migrations'`,
    ),
  );
}

describe('the function that lists applied migrations', () => {
  it('is created once: a second migrate changes nothing and reports nothing to apply', async () => {
    const { database, env } = await migrated();
    const before = await functionState(database);
    const second = await runCli(['migrate'], env).done;
    expect(second).toMatchObject({ code: 0 });
    expect(second.stdout).toContain('nothing to apply');
    expect(await functionState(database)).toBe(before);
  });

  it('runs with its owner’s rights, a fixed search path, schema-qualified names, and execute rights for the app role only', async () => {
    const { database } = await migrated();
    const [state] = await rows(
      database.ownerUrl,
      `SELECT p.prosecdef, p.proconfig::text AS config, p.proacl::text AS acl, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'applied_migrations'`,
    );
    expect(state?.['prosecdef']).toBe(true);
    expect(state?.['config']).toContain('search_path=pg_catalog, pg_temp');
    expect(String(state?.['prosrc'])).toContain('public.kysely_migration');
    const acl = String(state?.['acl']);
    expect(acl).toContain(`${database.appRole}=X/`);
    expect(acl).not.toMatch(/(^\{|,)=X\//);
  });

  it('cannot be run by a role that was not granted it', async () => {
    const { database } = await migrated();
    const admin = new pg.Client({ connectionString: database.adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE stranger LOGIN PASSWORD 'stranger-password'`);
    } finally {
      await admin.end();
    }
    const url = new URL(database.appUrl);
    url.username = 'stranger';
    url.password = 'stranger-password';
    expect(await attempt(url.toString(), 'SELECT public.applied_migrations()')).toMatch(/permission denied/);
  });

  it('gives the app role migration names only, and leaves the history tables closed to it', async () => {
    const { database } = await migrated();
    const client = new pg.Client({ connectionString: database.appUrl });
    await client.connect();
    try {
      const result = await client.query<{ name: string }>('SELECT public.applied_migrations() AS name');
      expect(result.rows.map((row) => row.name)).toEqual(['0001-baseline', '0002-deployment-and-users', '0003-applied-migrations-function', '0004-sources', '0005-source-checks', '0006-source-check-identity', '0007-source-check-config', '0008-investigations', '0009-reference-key', '0010-reference-length', '0011-saved-views-listing', '0012-saved-views-deletion']);
      expect(Object.keys(result.fields.map((field) => field.name))).toHaveLength(1);
    } finally {
      await client.end();
    }
    for (const statement of [
      'SELECT * FROM kysely_migration',
      "INSERT INTO kysely_migration (name, timestamp) VALUES ('x', 'y')",
      'SELECT * FROM kysely_migration_lock',
      'UPDATE kysely_migration_lock SET is_locked = 1',
      "INSERT INTO graphile_worker.migrations (id, ts, breaking) VALUES (999, now(), false)",
    ]) {
      expect(await attempt(database.appUrl, statement), statement).toMatch(/permission denied/);
    }
    expect(await attempt(database.appUrl, 'SELECT * FROM graphile_worker.migrations')).toBe('allowed');
  });
});
