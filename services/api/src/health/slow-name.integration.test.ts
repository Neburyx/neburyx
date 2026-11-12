import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SLOW_NAME, slowLookupInProcess } from '../testing/slow-name.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { runCli } from '../testing/cli.js';
import { forwardTo } from '../testing/forwarder.js';
import { startApi, stopApi } from '../testing/start-api.js';

const SLOW_MS = 5000;
const LIMIT_MS = 3000;
const TOLERANCE_MS = 2000;
const SETTLE_MS = 200;

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

function slowUrl(url: string): string {
  const slow = new URL(url);
  slow.hostname = SLOW_NAME;
  return slow.toString();
}

describe('the API start with a database name that is slow to resolve', () => {
  it('looks the name up once for the store, the probes and the job runner together, and listens', async () => {
    const database = await migrated();
    const lookup = slowLookupInProcess('resolve', SLOW_MS);
    try {
      const { result } = await startApi({ DATABASE_URL: slowUrl(database.appUrl) }, undefined, {});
      expect(result.exitCode).toBe(0);
      expect(lookup.lookups()).toBe(1);
      await stopApi(result);
    } finally {
      lookup.restore();
    }
  });

  it('stops within the connect limit, naming the lookup and the setting and nothing of the connection string, when the name is never answered', async () => {
    const database = await migrated();
    const lookup = slowLookupInProcess('never', 0);
    try {
      const started = Date.now();
      const { result, stderr } = await startApi({ DATABASE_URL: slowUrl(database.appUrl), NEBURYX_DATABASE_CONNECT_TIMEOUT_MS: String(LIMIT_MS) });
      expect(result.exitCode).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(LIMIT_MS + TOLERANCE_MS);
      expect(stderr).toBe('the database could not be reached: the name lookup or the connection took longer than NEBURYX_DATABASE_CONNECT_TIMEOUT_MS\n');
      expect(stderr).not.toContain(SLOW_NAME);
      expect(stderr).not.toContain('postgres://');
    } finally {
      lookup.restore();
    }
  });

  it('says the name did not resolve when the lookup fails', async () => {
    const database = await migrated();
    const lookup = slowLookupInProcess('fail', 300);
    try {
      const { result, stderr } = await startApi({ DATABASE_URL: slowUrl(database.appUrl) });
      expect(result.exitCode).not.toBe(0);
      expect(stderr).toBe('the database could not be reached: the database name did not resolve\n');
    } finally {
      lookup.restore();
    }
  });

  it('does not start on a bad connect limit, naming the key and not the value', async () => {
    const database = await migrated();
    const { result, stderr } = await startApi({ DATABASE_URL: database.appUrl, NEBURYX_DATABASE_CONNECT_TIMEOUT_MS: 'soon' });
    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain('NEBURYX_DATABASE_CONNECT_TIMEOUT_MS');
    expect(stderr).not.toContain('soon');
  });
});

describe('GET /readyz on a database name that is slow to resolve', () => {
  it('answers 200 within the default limit on the first call and again after every connection was dropped, because the address is known', async () => {
    const database = await migrated();
    const forwarder = await forwardTo(database.appUrl);
    const lookup = slowLookupInProcess('resolve', SLOW_MS);
    try {
      const { result } = await startApi({ DATABASE_URL: slowUrl(forwarder.url) });
      expect(result.exitCode).toBe(0);
      if (result.exitCode !== 0) return;
      for (const phase of ['first call', 'after the connections were dropped']) {
        if (phase !== 'first call') {
          await forwarder.stop();
          await forwarder.resume();
          await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        }
        const started = Date.now();
        const response = await result.app.inject({ method: 'GET', url: '/readyz' });
        expect(response.statusCode, phase).toBe(200);
        expect(Date.now() - started, phase).toBeLessThan(2000);
      }
      expect(lookup.lookups()).toBe(1);
      await stopApi(result);
    } finally {
      lookup.restore();
      await forwarder.stop();
    }
  });

  it('answers 503 unreachable within the default limit when the database stops, the address being known', async () => {
    const database = await migrated();
    const forwarder = await forwardTo(database.appUrl);
    const lookup = slowLookupInProcess('resolve', SLOW_MS);
    try {
      const { result } = await startApi({ DATABASE_URL: slowUrl(forwarder.url) });
      expect(result.exitCode).toBe(0);
      if (result.exitCode !== 0) return;
      await forwarder.stop();
      const started = Date.now();
      const response = await result.app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body).checks.database).toBe('unreachable');
      expect(Date.now() - started).toBeLessThan(2000);
      await stopApi(result);
    } finally {
      lookup.restore();
    }
  });
});
