import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

async function stored(database: TestDatabase): Promise<{ readonly deployment: readonly Record<string, unknown>[]; readonly users: readonly Record<string, unknown>[] }> {
  return {
    deployment: await rows(database.ownerUrl, 'SELECT * FROM deployment'),
    users: await rows(database.ownerUrl, 'SELECT * FROM users'),
  };
}

describe('a database the API cannot use', () => {
  it('exits 1 with the plain message and nothing else when it cannot be reached', async () => {
    const { result, stderr } = await startApi({ DATABASE_URL: 'postgres://app_user:secret-word@127.0.0.1:1/neburyx' });
    expect(result.exitCode).toBe(1);
    expect(stderr).toBe('the database could not be reached\n');
  });

  it('exits 1 with the plain message when migrate has not run, and creates no table', async () => {
    const database = await postgres.newDatabase();
    const { result, stderr } = await startApi({ DATABASE_URL: database.appUrl });
    expect(result.exitCode).toBe(1);
    expect(stderr).toBe('the database has not been migrated\n');
    expect(await rows(database.ownerUrl, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).toEqual([]);
  });
});

describe('the first start', () => {
  it('creates the community deployment row and the local administrator, whose id is a version 7 UUID', async () => {
    const database = await migrated();
    const { result } = await startApi({ DATABASE_URL: database.appUrl });
    expect(result.exitCode).toBe(0);
    await stopApi(result);

    const { deployment, users } = await stored(database);
    expect(deployment).toHaveLength(1);
    expect(deployment[0]).toMatchObject({ id: true, edition: 'community', identity_mode: 'none' });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      issuer: 'local',
      subject: 'local',
      display_name: 'Local workspace',
      role: 'administrator',
      status: 'active',
      break_glass: false,
    });
    expect(users[0]?.['id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('changes nothing on the next start: one row each, every column the same', async () => {
    const database = await migrated();
    const first = await startApi({ DATABASE_URL: database.appUrl });
    await stopApi(first.result);
    const before = JSON.stringify(await stored(database));

    const second = await startApi({ DATABASE_URL: database.appUrl });
    expect(second.result.exitCode).toBe(0);
    await stopApi(second.result);
    expect(JSON.stringify(await stored(database))).toBe(before);
    expect((await stored(database)).users).toHaveLength(1);
  });
});
