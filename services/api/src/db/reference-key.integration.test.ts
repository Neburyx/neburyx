import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppStore, type AppStore } from '../app-store.js';
import { runCli } from '../testing/cli.js';
import { attempt, rows } from '../testing/database.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));

let postgres: TestPostgres;
const stores: AppStore[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await postgres.stop();
});

async function migratedDatabase() {
  const database = await postgres.newDatabase();
  const result = await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done;
  expect(result.code).toBe(0);
  return database;
}

function storeOn(url: string): AppStore {
  const store = createAppStore(url, () => undefined, { migrationsDirectory: SHIPPED });
  stores.push(store);
  return store;
}

describe('the reference key of the deployment', () => {
  it('is added by a migration with no value, and a second migrate changes nothing', async () => {
    const database = await migratedDatabase();
    const before = await rows(database.ownerUrl, `SELECT reference_key IS NULL AS empty FROM deployment`);
    expect(before).toEqual([]);
    await storeOn(database.appUrl).initialize();
    expect(await rows(database.ownerUrl, `SELECT reference_key IS NULL AS empty FROM deployment`)).toEqual([{ empty: true }]);
    const again = await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done;
    expect(again.code).toBe(0);
  });

  it('is made once by the first copy that asks, and every copy, also copies that ask at the same time, reads the same 32 bytes', async () => {
    const database = await migratedDatabase();
    const first = storeOn(database.appUrl);
    await first.initialize();
    const copies = Array.from({ length: 6 }, () => storeOn(database.appUrl));
    const keys = await Promise.all(copies.map((copy) => copy.referenceKey()));
    for (const key of keys) expect(key).toHaveLength(32);
    expect(new Set(keys.map((key) => key.toString('hex'))).size).toBe(1);
    expect((await first.referenceKey()).equals(keys[0] ?? Buffer.alloc(0))).toBe(true);
  });

  it('may be read and set by the app role only while it is empty, and a set key cannot be changed, cleared or shortened', async () => {
    const database = await migratedDatabase();
    await storeOn(database.appUrl).initialize();
    const key = '\\x' + '11'.repeat(32);
    expect(await attempt(database.appUrl, `UPDATE deployment SET reference_key = $1::bytea`, [key])).toBe('allowed');
    for (const statement of [`UPDATE deployment SET reference_key = '\\x${'22'.repeat(32)}'::bytea`, `UPDATE deployment SET reference_key = NULL`, `UPDATE deployment SET reference_key = '\\x1111'::bytea`]) {
      expect(await attempt(database.appUrl, statement)).not.toBe('allowed');
    }
    expect(await rows(database.appUrl, `SELECT encode(reference_key, 'hex') AS key FROM deployment`)).toEqual([{ key: '11'.repeat(32) }]);
  });

  it('refuses a key of another length even while empty', async () => {
    const database = await migratedDatabase();
    await storeOn(database.appUrl).initialize();
    expect(await attempt(database.appUrl, `UPDATE deployment SET reference_key = '\\x1111'::bytea`)).not.toBe('allowed');
  });
});
