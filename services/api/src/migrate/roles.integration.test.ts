import { runOnce } from 'graphile-worker';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFiles, attempt, fixtureFolder, removeFixtureFolders, rows, runInProcess } from '../testing/database.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
  removeFixtureFolders();
});

const ITEMS = 'CREATE TABLE items (id serial PRIMARY KEY, name text);';

function envFor(database: TestDatabase): Record<string, string> {
  return { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };
}

async function asAppRole<T>(database: TestDatabase, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: database.appUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function refusal(database: TestDatabase, statement: string): Promise<string> {
  return attempt(database.appUrl, statement);
}

async function migrated(files: Readonly<Record<string, string>> = { '0001-items.sql': ITEMS }): Promise<{ database: TestDatabase; directory: string }> {
  const database = await postgres.newDatabase();
  const directory = fixtureFolder(files);
  expect((await runInProcess(envFor(database), directory)).code).toBe(0);
  return { database, directory };
}

describe('the app role setting', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['naming no role', 'no_such_role_for_neburyx'],
  ])('exits 1 naming DATABASE_APP_ROLE when it is %s, without its value', async (_name, role) => {
    const database = await postgres.newDatabase();
    const env = { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: role };
    const result = await runInProcess(env, fixtureFolder({ '0001-items.sql': ITEMS }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_APP_ROLE');
    expect(result.stderr).not.toContain('no_such_role_for_neburyx');
  });
});

describe('what the app role cannot do', () => {
  it('create a table or alter one a migration created', async () => {
    const { database } = await migrated();
    expect(await refusal(database, 'CREATE TABLE sneaky (id integer)')).toMatch(/permission denied/);
    expect(await refusal(database, 'ALTER TABLE items ADD COLUMN extra text')).toMatch(/must be owner/);
  });

  it('read or write the migration history, or write graphile-worker\'s migrations table', async () => {
    const { database } = await migrated();
    for (const statement of [
      'SELECT * FROM kysely_migration',
      "INSERT INTO kysely_migration (name, timestamp) VALUES ('x', 'y')",
      'DELETE FROM kysely_migration',
      'SELECT * FROM kysely_migration_lock',
      'UPDATE kysely_migration_lock SET is_locked = 1',
      'DELETE FROM graphile_worker.migrations',
      'UPDATE graphile_worker.migrations SET id = id',
    ]) {
      expect(await refusal(database, statement), statement).toMatch(/permission denied/);
    }
  });
});

describe('what the app role can do', () => {
  it('read graphile-worker\'s migrations table', async () => {
    const { database } = await migrated();
    expect(await refusal(database, 'SELECT id FROM graphile_worker.migrations')).toBe('allowed');
  });

  it('select, insert, update and delete on a migration-created table, with its sequence', async () => {
    const { database } = await migrated();
    await asAppRole(database, async (client) => {
      await client.query("INSERT INTO items (name) VALUES ('a')");
      await client.query("INSERT INTO items (name) VALUES ('b')");
      await client.query("UPDATE items SET name = 'c' WHERE name = 'b'");
      expect((await client.query('SELECT name FROM items ORDER BY id')).rows).toEqual([{ name: 'a' }, { name: 'c' }]);
      await client.query("DELETE FROM items WHERE name = 'a'");
      expect((await client.query('SELECT count(*)::int AS n FROM items')).rows).toEqual([{ n: 1 }]);
    });
  });

  it('do the same on a table added by a later migration, after the next run', async () => {
    const { database, directory } = await migrated();
    addFiles(directory, { '0002-more.sql': 'CREATE TABLE more (id serial PRIMARY KEY, label text);' });
    expect((await runInProcess(envFor(database), directory)).code).toBe(0);
    await asAppRole(database, async (client) => {
      await client.query("INSERT INTO more (label) VALUES ('x')");
      await client.query("UPDATE more SET label = 'y'");
      expect((await client.query('SELECT label FROM more')).rows).toEqual([{ label: 'y' }]);
      await client.query('DELETE FROM more');
    });
  });

  it('keep a narrower right that a migration role set, across the next run', async () => {
    const { database, directory } = await migrated();
    const owner = new pg.Client({ connectionString: database.ownerUrl });
    await owner.connect();
    await owner.query(`REVOKE DELETE ON items FROM ${owner.escapeIdentifier(database.appRole)}`);
    await owner.end();
    expect((await runInProcess(envFor(database), directory)).code).toBe(0);
    expect(await refusal(database, 'DELETE FROM items')).toMatch(/permission denied/);
  });

  it('add a job through graphile-worker and run it with a worker', async () => {
    const { database } = await migrated();
    let ran = 0;
    await asAppRole(database, async (client) => {
      await client.query(`SELECT graphile_worker.add_job('noop', '{}'::json)`);
    });
    await runOnce({ connectionString: database.appUrl, taskList: { noop: async () => void (ran += 1) } });
    expect(ran).toBe(1);
    expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS n FROM graphile_worker.jobs')).toEqual([{ n: 0 }]);
  });
});

describe('default privileges', () => {
  it('are set once: a restriction a migration role adds survives the next run', async () => {
    const { database, directory } = await migrated();
    const owner = new pg.Client({ connectionString: database.ownerUrl });
    await owner.connect();
    try {
      await owner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE DELETE ON TABLES FROM ${owner.escapeIdentifier(database.appRole)}`);
    } finally {
      await owner.end();
    }
    addFiles(directory, { '0002-narrow.sql': 'CREATE TABLE narrow (id serial PRIMARY KEY, label text);' });
    expect((await runInProcess(envFor(database), directory)).code).toBe(0);
    expect(await refusal(database, "INSERT INTO narrow (label) VALUES ('x')")).toBe('allowed');
    expect(await refusal(database, 'DELETE FROM narrow')).toMatch(/permission denied/);
  });

  it('stay revoked when a migration role removes every default: the next run does not restore them', async () => {
    const { database, directory } = await migrated();
    const owner = new pg.Client({ connectionString: database.ownerUrl });
    await owner.connect();
    try {
      const app = owner.escapeIdentifier(database.appRole);
      await owner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${app}`);
      await owner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${app}`);
    } finally {
      await owner.end();
    }
    addFiles(directory, { '0002-closed.sql': 'CREATE TABLE closed (id serial PRIMARY KEY, label text);' });
    expect((await runInProcess(envFor(database), directory)).code).toBe(0);
    expect(await refusal(database, 'SELECT * FROM closed')).toMatch(/permission denied/);
    expect(await refusal(database, "SELECT nextval('closed_id_seq')")).toMatch(/permission denied/);
  });
});

describe('the queue grants', () => {
  it('are applied as one step: when it fails, none of it is kept', async () => {
    const { database, directory } = await migrated();
    const owner = new pg.Client({ connectionString: database.ownerUrl });
    const admin = new pg.Client({ connectionString: database.adminUrl });
    await Promise.all([owner.connect(), admin.connect()]);
    try {
      await owner.query(`REVOKE DELETE ON graphile_worker._private_job_queues FROM ${owner.escapeIdentifier(database.appRole)}`);
      await admin.query('CREATE TABLE graphile_worker.foreign_table (id integer)');
      await admin.query('ALTER TABLE graphile_worker.foreign_table ENABLE ROW LEVEL SECURITY');
    } finally {
      await Promise.all([owner.end(), admin.end()]);
    }

    const result = await runInProcess(envFor(database), directory);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('job queue step failed');
    expect(await refusal(database, 'DELETE FROM graphile_worker._private_job_queues')).toMatch(/permission denied/);
  });

  it('leave the privileges and policies untouched on a second run', async () => {
    const { database, directory } = await migrated();
    const snapshot = async (): Promise<string> =>
      JSON.stringify(
        await rows(
          database.ownerUrl,
          `SELECT c.relname, c.relacl::text AS acl, (SELECT string_agg(policyname || ':' || roles::text, ',') FROM pg_policies p WHERE p.tablename = c.relname) AS policies
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'graphile_worker' ORDER BY c.relname`,
        ),
      );
    const before = await snapshot();
    expect((await runInProcess(envFor(database), directory)).code).toBe(0);
    expect(await snapshot()).toBe(before);
  });
});
