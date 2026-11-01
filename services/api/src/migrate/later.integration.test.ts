import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFiles, fixtureFolder, removeFixtureFolders, rows, runInProcess } from '../testing/database.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
  removeFixtureFolders();
});

describe('a migration file added after earlier runs', () => {
  it('is refused, named, and applies nothing when its name sorts before an applied one', async () => {
    const database = await postgres.newDatabase();
    const env = { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };
    const directory = fixtureFolder({
      '0001-a.sql': 'CREATE TABLE table_a (id integer);',
      '0003-c.sql': 'CREATE TABLE table_c (id integer);',
    });
    expect((await runInProcess(env, directory)).code).toBe(0);

    addFiles(directory, { '0002-b.sql': 'CREATE TABLE table_b (id integer);' });
    const result = await runInProcess(env, directory);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('0002-b');
    expect(result.stderr).not.toContain('table_b');
    expect(await rows(database.ownerUrl, `SELECT to_regclass('public.table_b') AS found`)).toEqual([{ found: null }]);
    expect(await rows(database.ownerUrl, 'SELECT name FROM kysely_migration ORDER BY name')).toEqual([
      { name: '0001-a' },
      { name: '0003-c' },
    ]);
  });

  it('is applied alone by the next run when its name sorts after the applied ones', async () => {
    const database = await postgres.newDatabase();
    const env = { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };
    const directory = fixtureFolder({ '0001-a.sql': 'CREATE TABLE table_a (id integer);' });
    const first = await runInProcess(env, directory);
    expect(first.stdout).toContain('applied 0001-a');

    addFiles(directory, { '0002-b.sql': 'CREATE TABLE table_b (id integer);' });
    const second = await runInProcess(env, directory);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('applied 0002-b');
    expect(second.stdout).not.toContain('0001-a');
    expect(await rows(database.ownerUrl, 'SELECT name FROM kysely_migration ORDER BY name')).toEqual([
      { name: '0001-a' },
      { name: '0002-b' },
    ]);
    expect(await rows(database.ownerUrl, `SELECT to_regclass('public.table_b') IS NOT NULL AS found`)).toEqual([{ found: true }]);
  });
});
