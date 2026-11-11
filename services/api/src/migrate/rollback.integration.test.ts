import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../testing/cli.js';
import { addFiles, attempt, fixtureFolder, removeFixtureFolders, rows, runInProcess, snapshot } from '../testing/database.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
  removeFixtureFolders();
});

const APPLIED_NAMES_FUNCTION = `
CREATE FUNCTION public.applied_migrations() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT name FROM public.kysely_migration ORDER BY name $$;
REVOKE ALL ON FUNCTION public.applied_migrations() FROM PUBLIC;
`;

function envFor(database: TestDatabase): Record<string, string> {
  return { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };
}

async function appliedNamesSeenByApp(database: TestDatabase): Promise<readonly string[]> {
  const found = await rows(database.appUrl, 'SELECT name FROM public.applied_migrations() AS name');
  return found.map((row) => String(row['name']));
}

/** Builds what a rollback leaves: runs the newer files, then removes them from the folder the older image ships. */
async function afterRollback(database: TestDatabase, newer: Record<string, string>, removed: readonly string[]): Promise<string> {
  const directory = fixtureFolder(newer);
  expect((await runInProcess(envFor(database), directory)).code).toBe(0);
  for (const name of removed) rmSync(join(directory, `${name}.sql`));
  return directory;
}

describe('a database that has applied migrations the image does not ship', () => {
  it('runs with nothing to apply, changes nothing, and keeps the app role able to see the applied names', async () => {
    const database = await postgres.newDatabase();
    const directory = await afterRollback(
      database,
      {
        '0001-first.sql': `CREATE TABLE table_one (id integer);\n${APPLIED_NAMES_FUNCTION}`,
        '0002-second.sql': 'CREATE TABLE table_two (id integer);',
        '0003-third.sql': 'CREATE TABLE table_three (id integer);',
      },
      ['0003-third'],
    );
    const before = await snapshot(database);

    const result = await runInProcess(envFor(database), directory);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('nothing to apply');
    expect(await snapshot(database)).toBe(before);
    expect(await attempt(database.appUrl, 'SELECT * FROM kysely_migration')).toMatch(/permission denied/);
    expect(await appliedNamesSeenByApp(database)).toEqual(['0001-first', '0002-second', '0003-third']);
  });

  it('applies only the pending file it ships, which sorts after every applied name', async () => {
    const database = await postgres.newDatabase();
    const directory = await afterRollback(
      database,
      { '0001-first.sql': 'CREATE TABLE table_one (id integer);', '0002-second.sql': 'CREATE TABLE table_two (id integer);', '0003-third.sql': 'CREATE TABLE table_three (id integer);' },
      ['0003-third'],
    );
    addFiles(directory, { '0004-fourth.sql': 'CREATE TABLE table_four (id integer);' });

    const result = await runInProcess(envFor(database), directory);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('applied 0004-fourth');
    expect(result.stdout).not.toContain('0001-first');
    expect(await rows(database.ownerUrl, 'SELECT name FROM kysely_migration ORDER BY name')).toEqual([
      { name: '0001-first' },
      { name: '0002-second' },
      { name: '0003-third' },
      { name: '0004-fourth' },
    ]);
    expect(await rows(database.ownerUrl, `SELECT to_regclass('public.table_three') IS NOT NULL AS three, to_regclass('public.table_four') IS NOT NULL AS four`)).toEqual([
      { three: true, four: true },
    ]);
  });

  it('applies a shipped pending file that sorts after an unshipped applied name that sits between shipped ones', async () => {
    const database = await postgres.newDatabase();
    const directory = await afterRollback(
      database,
      { '0001-first.sql': 'CREATE TABLE table_one (id integer);', '0002-unshipped.sql': 'CREATE TABLE table_unshipped (id integer);' },
      ['0002-unshipped'],
    );
    addFiles(directory, { '0003-later.sql': 'CREATE TABLE table_later (id integer);' });

    const result = await runInProcess(envFor(database), directory);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toBe('applied 0003-later\n');
  });

  it('refuses, names the file and applies nothing when a shipped pending file sorts before an unshipped applied name', async () => {
    const database = await postgres.newDatabase();
    const directory = await afterRollback(
      database,
      { '0001-first.sql': 'CREATE TABLE table_one (id integer);', '0003-third.sql': 'CREATE TABLE table_three (id integer);' },
      ['0003-third'],
    );
    addFiles(directory, { '0002-second.sql': 'CREATE TABLE table_two (id integer);' });
    const before = await snapshot(database);

    const result = await runInProcess(envFor(database), directory);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('0002-second');
    expect(result.stderr).toContain('sorts before');
    for (const text of ['table_two', 'CREATE TABLE', 'corrupted']) expect(result.stderr).not.toContain(text);
    expect(result.stdout).toBe('');
    expect(await rows(database.ownerUrl, `SELECT to_regclass('public.table_two') AS found`)).toEqual([{ found: null }]);
    expect(await snapshot(database)).toBe(before);
  });

  it('still refuses a shipped pending file that sorts before a shipped applied one', async () => {
    const database = await postgres.newDatabase();
    const directory = fixtureFolder({ '0001-first.sql': 'CREATE TABLE table_one (id integer);', '0003-third.sql': 'CREATE TABLE table_three (id integer);' });
    expect((await runInProcess(envFor(database), directory)).code).toBe(0);
    addFiles(directory, { '0002-second.sql': 'CREATE TABLE table_two (id integer);' });

    const result = await runInProcess(envFor(database), directory);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('0002-second');
  });

  it('is accepted by the built command over the real migrations, with the app role still seeing the name', async () => {
    const database = await postgres.newDatabase();
    const env = envFor(database);
    expect((await runCli(['migrate'], env).done).code).toBe(0);
    await rows(
      database.ownerUrl,
      `INSERT INTO kysely_migration (name, timestamp) VALUES ('9999-from-a-newer-image', to_char(now() + interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
    );
    const before = await snapshot(database);

    const result = await runCli(['migrate'], env).done;
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('nothing to apply');
    expect(await snapshot(database)).toBe(before);
    expect(await appliedNamesSeenByApp(database)).toContain('9999-from-a-newer-image');
  });
});
