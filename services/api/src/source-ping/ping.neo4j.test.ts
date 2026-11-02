import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readyResponseSchema } from '@neburyx/contracts';
import { rows, runInProcess } from '../testing/database.js';
import { sourceWith } from '../testing/gate-fixtures.js';
import { fileOf } from '../testing/mapping.js';
import { neo4jImageFrom, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-container.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { startApi, stopApi, webRoot } from '../testing/start-api.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const INTERVAL_MS = 1000;
const folder = mkdtempSync(join(tmpdir(), 'ping-neo4j-'));
let postgres: TestPostgres;
let steady: RunningNeo4j;
let flaky: RunningNeo4j;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return typeof address === 'object' && address !== null ? address.port : 0;
}

beforeAll(async () => {
  const port = await freePort();
  [postgres, steady, flaky] = await Promise.all([startPostgres(), startNeo4j(), startNeo4j(undefined, { hostPort: port })]);
});

afterAll(async () => {
  await runAll([() => postgres?.stop(), () => steady?.stop(), () => flaky?.stop()]);
  rmSync(folder, { recursive: true, force: true });
  rmSync(webRoot, { recursive: true, force: true });
});

const auth = (prefix: string) => ({ kind: 'basic', username_env: `${prefix}_USER`, password_env: `${prefix}_PASSWORD` });

async function migrated(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runInProcess({ DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }, SHIPPED);
  expect(result.code, result.stderr).toBe(0);
  return database;
}

describe(`the ping against ${neo4jImageFrom(process.env)}`, () => {
  it('shows a stopped source unreachable within two intervals and reachable again within two intervals of its answering, while the other stays reachable', async () => {
    const database = await migrated();
    const file = join(folder, 'neburyx.yaml');
    writeFileSync(file, fileOf(sourceWith('alpha', { uri: steady.boltUri, database: 'neo4j', auth: auth('ALPHA') }), sourceWith('beta', { uri: flaky.boltUri, database: 'neo4j', auth: auth('BETA') })));
    const env = {
      DATABASE_URL: database.appUrl,
      NEBURYX_CONFIG: file,
      ALPHA_USER: steady.user,
      ALPHA_PASSWORD: steady.password,
      BETA_USER: flaky.user,
      BETA_PASSWORD: flaky.password,
    };
    const { result } = await startApi(env, undefined, { pingIntervalMs: INTERVAL_MS });
    if (result.exitCode !== 0) throw new Error('the API did not start');
    const counts = async () => readyResponseSchema.parse((await result.app.inject({ method: 'GET', url: '/readyz' })).json()).sources;
    try {
      expect(await counts()).toEqual({ reachable: 2, unreachable: 0, unknown: 0 });

      await flaky.halt();
      await vi.waitFor(async () => expect(await counts()).toEqual({ reachable: 1, unreachable: 1, unknown: 0 }), { timeout: 2 * INTERVAL_MS + 1000, interval: 100 });

      await flaky.resume();
      await vi.waitFor(async () => expect(await counts()).toEqual({ reachable: 2, unreachable: 0, unknown: 0 }), { timeout: 2 * INTERVAL_MS + 1000, interval: 100 });
      expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS checks FROM source_checks')).toEqual([{ checks: 2 }]);
    } finally {
      await stopApi(result);
    }
  });
});
