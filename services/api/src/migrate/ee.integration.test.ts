import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearRegisteredExtension, EXTENSION_LOAD_FAILED_MESSAGE, NO_EXTENSION_MESSAGE, type ExtensionLoader } from '../profile/extension.js';
import { addFiles, attempt, fixtureFolder, removeFixtureFolders, rows, runInProcess } from '../testing/database.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
  removeFixtureFolders();
  clearRegisteredExtension();
});

const COMMUNITY = { '0001-a.sql': 'CREATE TABLE community_a (id integer);' };
const EE = { 'ee-0001-things.sql': 'CREATE TABLE ee_things (id integer);' };

const mappingFile = (ai: unknown): string => join(fixtureFolder({ 'neburyx.yaml': stringify({ sources: [], ...(ai === undefined ? {} : { ai }) }) }), 'neburyx.yaml');
const PREVIEW_FILE = mappingFile({ preview: true });
const PLAIN_FILE = mappingFile(undefined);

const loaderFor = (directory: string | undefined): ExtensionLoader => ({
  load: async () => ({ name: 'fake', routeGroups: [], ...(directory === undefined ? {} : { migrationsDirectory: directory }) }),
});

async function database() {
  const created = await postgres.newDatabase();
  return { ...created, env: { DATABASE_MIGRATION_URL: created.ownerUrl, DATABASE_APP_ROLE: created.appRole } };
}

const eeNames = (url: string) => rows(url, 'SELECT name FROM kysely_migration_ee ORDER BY name');
const communityNames = (url: string) => rows(url, 'SELECT name FROM kysely_migration ORDER BY name');
const found = async (url: string, table: string) => (await rows(url, `SELECT to_regclass('public.${table}') IS NOT NULL AS found`))[0]?.found;

describe('migrate with neither part of the preview switch set', () => {
  it('applies only the community migrations, creates no enterprise history, and never loads the extension', async () => {
    const db = await database();
    let loads = 0;
    const loader: ExtensionLoader = { load: () => (loads++, loaderFor(fixtureFolder(EE)).load()) };
    const result = await runInProcess(db.env, fixtureFolder(COMMUNITY), { extensionLoader: loader });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('applied 0001-a\n');
    expect(loads).toBe(0);
    expect(await found(db.ownerUrl, 'kysely_migration_ee')).toBe(false);
    expect(await found(db.ownerUrl, 'ee_things')).toBe(false);
  });

  it('does the same with a mapping file that has no ai section', async () => {
    const db = await database();
    const result = await runInProcess({ ...db.env, NEBURYX_CONFIG: PLAIN_FILE }, fixtureFolder(COMMUNITY));
    expect(result.code).toBe(0);
    expect(await found(db.ownerUrl, 'kysely_migration_ee')).toBe(false);
  });
});

describe('migrate with both parts set', () => {
  const on = (db: { readonly env: Record<string, string> }) => ({ ...db.env, NEBURYX_CONFIG: PREVIEW_FILE, NEBURYX_PROFILE: 'enterprise' });

  it('applies the community migrations, then the enterprise ones into a history of their own, and a second run has nothing to apply', async () => {
    const db = await database();
    const community = fixtureFolder(COMMUNITY);
    const ee = fixtureFolder(EE);
    const first = await runInProcess(on(db), community, { extensionLoader: loaderFor(ee) });
    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);
    expect(first.stdout).toBe('applied 0001-a, ee-0001-things\n');
    expect(await communityNames(db.ownerUrl)).toEqual([{ name: '0001-a' }]);
    expect(await eeNames(db.ownerUrl)).toEqual([{ name: 'ee-0001-things' }]);
    expect(await found(db.ownerUrl, 'ee_things')).toBe(true);
    const second = await runInProcess(on(db), community, { extensionLoader: loaderFor(ee) });
    expect([second.code, second.stdout]).toEqual([0, 'nothing to apply\n']);
  });

  it('applies a later community migration with no refusal when an enterprise one is already applied', async () => {
    const db = await database();
    const community = fixtureFolder(COMMUNITY);
    const ee = fixtureFolder(EE);
    expect((await runInProcess(on(db), community, { extensionLoader: loaderFor(ee) })).code).toBe(0);
    addFiles(community, { '0002-b.sql': 'CREATE TABLE community_b (id integer);' });
    const second = await runInProcess(on(db), community, { extensionLoader: loaderFor(ee) });
    expect([second.code, second.stdout]).toEqual([0, 'applied 0002-b\n']);
    expect(await eeNames(db.ownerUrl)).toEqual([{ name: 'ee-0001-things' }]);
  });

  it('keeps both enterprise history tables closed to the application role', async () => {
    const db = await database();
    expect((await runInProcess(on(db), fixtureFolder(COMMUNITY), { extensionLoader: loaderFor(fixtureFolder(EE)) })).code).toBe(0);
    expect(await attempt(db.appUrl, 'SELECT * FROM kysely_migration_ee')).toMatch(/permission denied/);
    expect(await attempt(db.appUrl, "INSERT INTO kysely_migration_ee (name, timestamp) VALUES ('x', 'y')")).toMatch(/permission denied/);
    expect(await attempt(db.appUrl, 'SELECT * FROM kysely_migration_lock_ee')).toMatch(/permission denied/);
    expect(await attempt(db.appUrl, 'SELECT * FROM ee_things')).not.toMatch(/permission denied/);
  });

  it('exits 1 naming a failing enterprise migration without its SQL, and keeps the community migrations of the run', async () => {
    const db = await database();
    const ee = fixtureFolder({ 'ee-0001-bad.sql': "INSERT INTO missing_table VALUES ('secret-value');" });
    const result = await runInProcess(on(db), fixtureFolder(COMMUNITY), { extensionLoader: loaderFor(ee) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ee-0001-bad');
    expect(result.stderr).toContain('application migrations and the job queue step of this run are applied');
    expect(result.stderr).not.toContain('nothing from this run was applied');
    for (const text of ['secret-value', 'missing_table', 'INSERT']) expect(result.stderr).not.toContain(text);
    expect(await communityNames(db.ownerUrl)).toEqual([{ name: '0001-a' }]);
    expect(await eeNames(db.ownerUrl)).toEqual([]);
  });

  it('does not fail on an applied enterprise name that the image no longer ships', async () => {
    const db = await database();
    const community = fixtureFolder(COMMUNITY);
    const shipped = fixtureFolder({ ...EE, 'ee-0002-more.sql': 'CREATE TABLE ee_more (id integer);' });
    expect((await runInProcess(on(db), community, { extensionLoader: loaderFor(shipped) })).code).toBe(0);
    const older = fixtureFolder(EE);
    const result = await runInProcess(on(db), community, { extensionLoader: loaderFor(older) });
    expect([result.code, result.stdout]).toEqual([0, 'nothing to apply\n']);
    expect(await eeNames(db.ownerUrl)).toEqual([{ name: 'ee-0001-things' }, { name: 'ee-0002-more' }]);
  });

  it('refuses an enterprise migration that sorts before one already applied, naming it, and keeps the community migrations', async () => {
    const db = await database();
    const community = fixtureFolder(COMMUNITY);
    expect((await runInProcess(on(db), community, { extensionLoader: loaderFor(fixtureFolder({ 'ee-0002-b.sql': 'CREATE TABLE ee_b (id integer);' })) })).code).toBe(0);
    const both = fixtureFolder({ 'ee-0001-a.sql': 'CREATE TABLE ee_a (id integer);', 'ee-0002-b.sql': 'CREATE TABLE ee_b (id integer);' });
    const result = await runInProcess(on(db), community, { extensionLoader: loaderFor(both) });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('enterprise migration ee-0001-a sorts before an enterprise migration that was already applied; give a new migration a later name\n');
    expect(await found(db.ownerUrl, 'ee_a')).toBe(false);
  });

  it('exits 1 with its own message when the enterprise step fails for another reason, keeping what was applied', async () => {
    const db = await database();
    const result = await runInProcess(on(db), fixtureFolder(COMMUNITY), { extensionLoader: loaderFor(join(fixtureFolder({}), 'no-such-folder')) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('the enterprise migration step failed; the application migrations and the job queue step of this run are applied');
    expect(result.stderr).not.toContain('no-such-folder');
    expect(result.stderr).not.toContain('the migration run failed');
    expect(await communityNames(db.ownerUrl)).toEqual([{ name: '0001-a' }]);
  });

  it('considers only the community migrations once the switch is turned off, and leaves the enterprise history and tables', async () => {
    const db = await database();
    const community = fixtureFolder(COMMUNITY);
    expect((await runInProcess(on(db), community, { extensionLoader: loaderFor(fixtureFolder(EE)) })).code).toBe(0);
    addFiles(community, { '0002-b.sql': 'CREATE TABLE community_b (id integer);' });
    const off = await runInProcess(db.env, community);
    expect([off.code, off.stdout]).toEqual([0, 'applied 0002-b\n']);
    expect(await eeNames(db.ownerUrl)).toEqual([{ name: 'ee-0001-things' }]);
    expect(await found(db.ownerUrl, 'ee_things')).toBe(true);
  });
});

describe('migrate with only one part of the switch set, or with no enterprise code', () => {
  it.each([
    ['the profile and no mapping file', { NEBURYX_PROFILE: 'enterprise' }, 'NEBURYX_PROFILE=enterprise is set but ai.preview: true is not set'],
    ['the profile and a mapping file without ai.preview', { NEBURYX_PROFILE: 'enterprise', NEBURYX_CONFIG: PLAIN_FILE }, 'NEBURYX_PROFILE=enterprise is set but ai.preview: true is not set'],
    ['ai.preview and no profile', { NEBURYX_CONFIG: PREVIEW_FILE }, 'ai.preview: true is set in the mapping file but NEBURYX_PROFILE=enterprise is not set'],
  ])('refuses %s before any phase, applying nothing', async (_name, extra, message) => {
    const db = await database();
    const result = await runInProcess({ ...db.env, ...extra }, fixtureFolder(COMMUNITY), { extensionLoader: loaderFor(fixtureFolder(EE)) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(await found(db.ownerUrl, 'kysely_migration')).toBe(false);
  });

  it('refuses a switch that is on when the build has no enterprise code, applying nothing', async () => {
    clearRegisteredExtension();
    const db = await database();
    const result = await runInProcess({ ...db.env, NEBURYX_CONFIG: PREVIEW_FILE, NEBURYX_PROFILE: 'enterprise' }, fixtureFolder(COMMUNITY));
    expect([result.code, result.stderr]).toEqual([1, `${NO_EXTENSION_MESSAGE}\n`]);
    expect(await found(db.ownerUrl, 'kysely_migration')).toBe(false);
  });

  it('refuses a switch that is on when the loader fails, applying nothing and printing no cause', async () => {
    const db = await database();
    const loader: ExtensionLoader = {
      load: async () => {
        throw new Error('cannot find /secret/place');
      },
    };
    const result = await runInProcess({ ...db.env, NEBURYX_CONFIG: PREVIEW_FILE, NEBURYX_PROFILE: 'enterprise' }, fixtureFolder(COMMUNITY), { extensionLoader: loader });
    expect([result.code, result.stderr]).toEqual([1, `${EXTENSION_LOAD_FAILED_MESSAGE}\n`]);
    expect(await found(db.ownerUrl, 'kysely_migration')).toBe(false);
  });
});
