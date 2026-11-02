import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readyResponseSchema } from '@neburyx/contracts';
import { rows, runInProcess } from '../testing/database.js';
import { sourceWith } from '../testing/gate-fixtures.js';
import { fileOf } from '../testing/mapping.js';
import { neo4jImageFrom, pollUntil, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-container.js';
import { seedFixtureGraph } from '../testing/seed-graph.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { startApi, stopApi, webRoot } from '../testing/start-api.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const INTERVAL_MS = 1000;
/** The longest a ping that was already in flight when the server came back can take: the budget of the source. */
const SOURCE_TIMEOUT_MS = 1000;
const WINDOW_MS = 2 * INTERVAL_MS + SOURCE_TIMEOUT_MS;
/** After the start the first pings may still be correcting a startup check that met a slow server. */
const STARTUP_WINDOW_MS = 20_000;
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
  await Promise.all([seedFixtureGraph(steady), seedFixtureGraph(flaky)]);
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
    writeFileSync(file, fileOf(sourceWith('alpha', { uri: steady.boltUri, database: 'neo4j', auth: auth('ALPHA'), budgets: { timeout_ms: SOURCE_TIMEOUT_MS } }), sourceWith('beta', { uri: flaky.boltUri, database: 'neo4j', auth: auth('BETA'), budgets: { timeout_ms: SOURCE_TIMEOUT_MS } })));
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
    /** Polls /readyz until it shows the counts, and fails with every observation when it does not within the window. */
    const shows = async (expected: { reachable: number; unreachable: number; unknown: number }, since: number, windowMs = WINDOW_MS): Promise<void> => {
      const seen: string[] = [];
      const reached = await pollUntil(async () => {
        const observed = await counts();
        seen.push(`+${Date.now() - since}ms ${JSON.stringify(observed)}`);
        return JSON.stringify(observed) === JSON.stringify(expected);
      }, windowMs, 100);
      expect(reached, `expected ${JSON.stringify(expected)} within ${windowMs} ms; observed:\n${seen.join('\n')}`).toBe(true);
    };
    try {
      await shows({ reachable: 2, unreachable: 0, unknown: 0 }, Date.now(), STARTUP_WINDOW_MS);

      await flaky.halt();
      await shows({ reachable: 1, unreachable: 1, unknown: 0 }, Date.now());

      await flaky.resume();
      await shows({ reachable: 2, unreachable: 0, unknown: 0 }, Date.now());
      expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS checks FROM source_checks')).toEqual([{ checks: 2 }]);
    } finally {
      await stopApi(result);
    }
  });
});
