import { rmSync } from 'node:fs';
import { meResponseSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ID } from '../gate/system-principal.js';
import { runCli } from '../testing/cli.js';
import { rows } from '../testing/database.js';
import { forwardTo } from '../testing/forwarder.js';
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

describe('GET /v1/me on a started API', () => {
  it('answers with the local principal, the community edition and no sources', async () => {
    const database = await migrated();
    const { result } = await startApi({ DATABASE_URL: database.appUrl });
    if (result.exitCode !== 0) throw new Error('the API did not start');
    try {
      const response = await result.app.inject({ method: 'GET', url: '/v1/me' });
      const [user] = await rows(database.ownerUrl, `SELECT id FROM users WHERE issuer = 'local'`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        principal: { id: user?.['id'], displayName: 'Local workspace', role: 'administrator' },
        edition: 'community',
        identityMode: 'none',
        sources: [],
      });
      const body = meResponseSchema.parse(response.json());
      expect(body.principal.id).not.toBe(SYSTEM_ID);
      expect(body.principal.id[14]).toBe('7');
    } finally {
      await stopApi(result);
    }
  });

  it('answers 500 INTERNAL_ERROR with a trace ID and no connection detail while the database stays down', async () => {
    const database = await migrated();
    const forwarder = await forwardTo(database.appUrl);
    const { result } = await startApi({ DATABASE_URL: forwarder.url });
    if (result.exitCode !== 0) throw new Error('the API did not start');
    try {
      await forwarder.stop();
      const response = await result.app.inject({ method: 'GET', url: '/v1/me' });
      expect(response.statusCode).toBe(500);
      const body: { error: { code: string; traceId: string } } = response.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.traceId).toBe(response.headers['x-trace-id']);
      for (const detail of [database.appRole, 'ECONNREFUSED', '127.0.0.1', 'postgres']) {
        expect(response.body).not.toContain(detail);
      }
    } finally {
      await stopApi(result);
    }
  });
});
