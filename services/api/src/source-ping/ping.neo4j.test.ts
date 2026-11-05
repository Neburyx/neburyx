import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forwardTo, type Forwarder } from '@neburyx/test-neo4j';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readyResponseSchema } from '@neburyx/contracts';
import { rows, runInProcess } from '../testing/database.js';
import { sourceWith } from '../testing/gate-fixtures.js';
import { fileOf } from '../testing/mapping.js';
import { pollUntil, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
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
let forwarder: Forwarder;

beforeAll(async () => {
  [postgres, steady, flaky] = await Promise.all([startPostgres(), startNeo4j(), startNeo4j()]);
  forwarder = await forwardTo(flaky.boltUri);
  await Promise.all([seedFixtureGraph(steady), seedFixtureGraph(flaky)]);
});

afterAll(async () => {
  await runAll([() => postgres?.stop(), () => forwarder?.close(), () => steady?.stop(), () => flaky?.stop()]);
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

describe(`the ping against the dev Neo4j server`, () => {
  it('shows a stopped source unreachable within two intervals and reachable again within two intervals of its answering, while the other stays reachable', async () => {
    const database = await migrated();
    const file = join(folder, 'neburyx.yaml');
    writeFileSync(file, fileOf(sourceWith('alpha', { uri: steady.boltUri, database: steady.database, auth: auth('ALPHA'), budgets: { timeout_ms: SOURCE_TIMEOUT_MS } }), sourceWith('beta', { uri: forwarder.uri, database: flaky.database, auth: auth('BETA'), budgets: { timeout_ms: SOURCE_TIMEOUT_MS } })));
    const env = {
      DATABASE_URL: database.appUrl,
      NEBURYX_CONFIG: file,
      ALPHA_USER: steady.reader.user,
      ALPHA_PASSWORD: steady.reader.password,
      BETA_USER: flaky.reader.user,
      BETA_PASSWORD: flaky.reader.password,
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

      await forwarder.stop();
      await shows({ reachable: 1, unreachable: 1, unknown: 0 }, Date.now());

      await forwarder.resume();
      await shows({ reachable: 2, unreachable: 0, unknown: 0 }, Date.now());
      expect(await rows(database.ownerUrl, 'SELECT count(*)::int AS checks FROM source_checks')).toEqual([{ checks: 2 }]);
    } finally {
      await stopApi(result);
    }
  });
});
