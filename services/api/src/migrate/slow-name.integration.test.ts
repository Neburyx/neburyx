import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../testing/cli.js';
import { slowName } from '../testing/slow-name.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';

const SLOW_MS = 5000;
const LIMIT_MS = 3000;
const TOLERANCE_MS = 2000;

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
});

async function migrateOn(name: ReturnType<typeof slowName>, extra: Readonly<Record<string, string>> = {}) {
  const database = await postgres.newDatabase();
  const started = Date.now();
  const result = await runCli(['migrate'], { DATABASE_MIGRATION_URL: name.urlFor(database.ownerUrl), DATABASE_APP_ROLE: database.appRole, ...name.env, ...extra }).done;
  return { database, result, tookMs: Date.now() - started };
}

describe('neburyx migrate with a database name that is slow to resolve', () => {
  it('looks the name up once for the whole run and applies the migrations', async () => {
    const name = slowName('resolve', SLOW_MS);
    try {
      const { result, tookMs } = await migrateOn(name);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('applied 0001-baseline');
      expect(name.lookups()).toBe(1);
      expect(tookMs).toBeLessThan(SLOW_MS + 15_000);
    } finally {
      name.remove();
    }
  });

  it('says nothing to apply on a second run, as before', async () => {
    const name = slowName('resolve', 0);
    try {
      const first = await migrateOn(name);
      expect(first.result.code).toBe(0);
      const again = await runCli(['migrate'], { DATABASE_MIGRATION_URL: name.urlFor(first.database.ownerUrl), DATABASE_APP_ROLE: first.database.appRole, ...name.env }).done;
      expect(again.stdout).toContain('nothing to apply');
    } finally {
      name.remove();
    }
  });

  it('stops within the connect limit, naming the lookup and the setting, when the name is never answered', async () => {
    const name = slowName('never', 0);
    try {
      const { result, tookMs } = await migrateOn(name, { NEBURYX_DATABASE_CONNECT_TIMEOUT_MS: String(LIMIT_MS) });
      expect(result.code).toBe(1);
      expect(tookMs).toBeLessThan(LIMIT_MS + TOLERANCE_MS + 1000);
      expect(result.stderr).toContain('the database could not be reached');
      expect(result.stderr).toContain('NEBURYX_DATABASE_CONNECT_TIMEOUT_MS');
      expect(result.stderr).not.toContain('slow-db.test');
    } finally {
      name.remove();
    }
  });

  it('says the name did not resolve, and shows no part of the connection string, when the lookup fails', async () => {
    const name = slowName('fail', 500);
    try {
      const { result } = await migrateOn(name);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe('the database could not be reached: the database name did not resolve\n');
    } finally {
      name.remove();
    }
  });

  it('refuses a bad connect limit naming the key and not the value', async () => {
    const name = slowName('resolve', 0);
    try {
      const { result } = await migrateOn(name, { NEBURYX_DATABASE_CONNECT_TIMEOUT_MS: 'soon' });
      expect(result.code).toBe(1);
      expect(result.stderr).toBe('invalid configuration: NEBURYX_DATABASE_CONNECT_TIMEOUT_MS\n');
    } finally {
      name.remove();
    }
  });
});
