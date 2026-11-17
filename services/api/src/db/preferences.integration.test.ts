import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppStore } from '../app-store.js';
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

async function migrated(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done;
  expect(result.code).toBe(0);
  return database;
}

const FIRST = '00000000-0000-7000-8000-000000000001';
const SECOND = '00000000-0000-7000-8000-000000000002';
const user = (id: string, subject: string): string => `INSERT INTO users (id, issuer, subject, display_name) VALUES ('${id}', 'issuer', '${subject}', 'Name')`;
const storeOf = (database: TestDatabase) =>
  createAppStore(database.appUrl, () => undefined, { migrationsDirectory: new URL('../../migrations', import.meta.url).pathname });

describe('the user_preferences table and its store', () => {
  it('is made once with a key for each user and key, and a row goes with its user', async () => {
    const database = await migrated();
    expect(await attempt(database.ownerUrl, user(FIRST, 'one'))).toBe('allowed');
    expect(await attempt(database.ownerUrl, `INSERT INTO user_preferences (user_id, key, value) VALUES ('${FIRST}', 'tour', '"completed"')`)).toBe('allowed');
    expect(await attempt(database.ownerUrl, `INSERT INTO user_preferences (user_id, key, value) VALUES ('${FIRST}', 'tour', '"skipped"')`)).toMatch(/user_preferences_pkey/);
    expect(await attempt(database.ownerUrl, `INSERT INTO user_preferences (user_id, key, value) VALUES ('${SECOND}', 'tour', '"skipped"')`)).toMatch(/foreign key|user_preferences_user_id_fkey/);
    expect(await attempt(database.ownerUrl, `DELETE FROM users WHERE id = '${FIRST}'`)).toBe('allowed');
    expect(await rows(database.ownerUrl, 'SELECT * FROM user_preferences')).toEqual([]);
  });

  it('stores, reads, replaces and keeps the preferences of two users apart, and a second migrate applies nothing', async () => {
    const database = await migrated();
    await attempt(database.ownerUrl, user(FIRST, 'one'));
    await attempt(database.ownerUrl, user(SECOND, 'two'));
    const store = storeOf(database);
    try {
      expect(await store.readPreferences(FIRST)).toEqual({});
      expect(await store.writePreferences(FIRST, { tour: 'skipped' })).toEqual({ tour: 'skipped' });
      expect(await store.writePreferences(FIRST, {})).toEqual({ tour: 'skipped' });
      expect(await store.writePreferences(FIRST, { tour: 'completed' })).toEqual({ tour: 'completed' });
      expect(await store.readPreferences(SECOND)).toEqual({});
    } finally {
      await store.close();
    }
    const again = storeOf(database);
    try {
      expect(await again.readPreferences(FIRST)).toEqual({ tour: 'completed' });
    } finally {
      await again.close();
    }
    const second = await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done;
    expect(second.code).toBe(0);
    expect(await rows(database.ownerUrl, `SELECT name FROM kysely_migration WHERE name LIKE '0021%'`)).toHaveLength(1);
  });

  it('ignores a stored key that is not in the list and a stored value that is no longer allowed', async () => {
    const database = await migrated();
    await attempt(database.ownerUrl, user(FIRST, 'one'));
    await attempt(database.ownerUrl, `INSERT INTO user_preferences (user_id, key, value) VALUES ('${FIRST}', 'density', '"compact"'), ('${FIRST}', 'tour', '"seen"')`);
    const store = storeOf(database);
    try {
      expect(await store.readPreferences(FIRST)).toEqual({});
    } finally {
      await store.close();
    }
  });
});
