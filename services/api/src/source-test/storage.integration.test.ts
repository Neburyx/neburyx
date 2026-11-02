import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sourceTestReportSchema, sourcesResponseSchema, type SourceTestReport } from '@neburyx/contracts';
import { buildApp } from '../app.js';
import { createAppStore, type AppStore } from '../app-store.js';
import { KEPT_CHECKS, serverVersionOf } from '../db/source-checks-repository.js';
import type { CapabilitiesItem } from '../gate/templates/capabilities.js';
import { uuidv7 } from '../identity/uuid.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { runCli } from '../testing/cli.js';
import { attempt, rows } from '../testing/database.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { fakeSourceTester, serverExecutor } from '../testing/source-tester.js';
import { webRoot } from '../testing/start-api.js';
import { createSourceTester } from './tester.js';
import { testSourceGate } from '../testing/source-gate.js';
import { reportFromFailure, reportFromServer } from './report.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const mapping = mappingOf(sourceWith('alpha'), sourceWith('beta'));
const [alpha, beta] = mapping.sources;
if (alpha === undefined || beta === undefined) throw new Error('the fixture mapping has two sources');

let postgres: TestPostgres;
const stores: AppStore[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await postgres.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

async function migrate(database: TestDatabase): Promise<void> {
  const result = await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done;
  expect(result.code).toBe(0);
}

async function openStore(): Promise<{ readonly database: TestDatabase; readonly store: AppStore }> {
  const database = await postgres.newDatabase();
  await migrate(database);
  const opened = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
  let closing: Promise<void> | undefined;
  const store: AppStore = { ...opened, close: () => (closing ??= opened.close()) };
  stores.push(store);
  await store.initialize();
  await store.syncSources(mapping.sources);
  return { database, store };
}

const SERVER: CapabilitiesItem = { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community', versionSupported: true, operations: [] };
const at = (minute: number): string => new Date(Date.UTC(2026, 10, 2, 10, minute, 0)).toISOString();
const pass = (sourceId: 'alpha' | 'beta', checkedAt: string): SourceTestReport => reportFromServer(sourceId === 'alpha' ? alpha : beta, SERVER, null, checkedAt);
const checkOf = (id: string, report: SourceTestReport, triggeredBy: string | null) => ({ id, report, triggeredBy, identityHash: identityHashOf(report.sourceId === 'beta' ? beta : alpha), configHash: (report.sourceId === 'beta' ? beta : alpha).configHash });
const failed = (checkedAt: string): SourceTestReport => reportFromFailure(alpha, 'unreachable', checkedAt);

describe('the source_checks table', () => {
  it('has the constraints and rights of the data-model, and a second migrate changes nothing', async () => {
    const database = await postgres.newDatabase();
    await migrate(database);
    await migrate(database);
    const columns = await rows(database.ownerUrl, `SELECT column_name FROM information_schema.columns WHERE table_name = 'source_checks' ORDER BY ordinal_position`);
    expect(columns.map((column) => column['column_name'])).toEqual(['id', 'source_id', 'checked_at', 'triggered_by', 'outcome', 'server_version', 'read_only_check', 'schema_hash', 'report', 'identity_hash', 'config_hash']);
    await rows(database.ownerUrl, `INSERT INTO sources (id, alias, connector, uri, database, secret_ref, config_hash, identity_hash) VALUES ('alpha', 'alpha', 'neo4j', 'bolt://x', 'neo4j', 'a:b', 'h', 'i')`);
    const insert = (outcome: string, readOnly: string, source = 'alpha', by: string | null = null) =>
      attempt(
        database.appUrl,
        `INSERT INTO source_checks (id, source_id, checked_at, triggered_by, outcome, read_only_check, report) VALUES ($1, $2, now(), $3, $4, $5, '{}')`,
        [uuidv7(), source, by, outcome, readOnly],
      );
    expect(await insert('pass', 'not-verified')).toBe('allowed');
    expect(await insert('maybe', 'not-verified')).toMatch(/source_checks_outcome_known/);
    expect(await insert('pass', 'guessed')).toMatch(/source_checks_read_only_check_known/);
    expect(await insert('pass', 'not-verified', 'absent')).toMatch(/foreign key/);
    expect(await insert('pass', 'not-verified', 'alpha', uuidv7())).toMatch(/foreign key/);
    expect(await attempt(database.appUrl, 'SELECT count(*) FROM source_checks')).toBe('allowed');
    expect(await attempt(database.appUrl, 'DELETE FROM source_checks')).toBe('allowed');
    expect(await attempt(database.appUrl, 'ALTER TABLE source_checks ADD COLUMN extra text')).toMatch(/must be owner/);
  });
});

describe('a stored run', () => {
  it('keeps the outcome, the server text, the report and who started it, and null for a startup run', async () => {
    const { database, store } = await openStore();
    const user = (await store.current()).principal.id;
    await store.recordSourceCheck(checkOf(uuidv7(), pass('alpha', at(1)), user));
    await store.recordSourceCheck(checkOf(uuidv7(), failed(at(2)), user));
    await store.recordSourceCheck(checkOf(uuidv7(), pass('alpha', at(3)), null));
    const stored = await rows(database.ownerUrl, `SELECT checked_at, triggered_by, outcome, server_version, read_only_check, schema_hash, report FROM source_checks ORDER BY checked_at`);
    expect(stored.map((row) => [row['outcome'], row['server_version'], row['triggered_by'], row['read_only_check'], row['schema_hash']])).toEqual([
      ['pass', 'Neo4j 5.26.32', user, 'not-verified', null],
      ['fail', null, user, 'not-verified', null],
      ['pass', 'Neo4j 5.26.32', null, 'not-verified', null],
    ]);
    expect(sourceTestReportSchema.parse(stored[0]?.['report'])).toEqual(pass('alpha', at(1)));
    expect(new Date(String(stored[0]?.['checked_at'])).toISOString()).toBe(at(1));
  });

  it('stores a warn report for a server that reported an empty version', async () => {
    const { database, store } = await openStore();
    await store.recordSourceCheck(checkOf(uuidv7(), reportFromServer(alpha, { ...SERVER, version: '', versionSupported: false }, null, at(1)), null));
    const stored = await rows(database.ownerUrl, `SELECT outcome, server_version FROM source_checks`);
    expect(stored).toEqual([{ outcome: 'warn', server_version: 'Neo4j ' }]);
    expect((await store.listSources()).find((row) => row.id === 'alpha')).toMatchObject({ state: 'degraded' });
  });

  it('writes the product with the version for a server that is not the Neo4j kernel', () => {
    expect(serverVersionOf({ ...pass('alpha', at(1)), server: { product: 'Another Server', version: '1.2.3', edition: 'x' } })).toBe('Another Server 1.2.3');
  });

  it.each([
    ['pass', pass('alpha', at(1)), 'connected', null],
    ['warn', reportFromServer(alpha, { ...SERVER, versionSupported: false }, null, at(1)), 'degraded', 'The server version is not on the support matrix.'],
    ['fail', failed(at(1)), 'unavailable', 'The source could not be reached.'],
  ])('moves the state of the source after a %s', async (_name, report, state, reason) => {
    const { store } = await openStore();
    await store.recordSourceCheck(checkOf(uuidv7(), report, null));
    const listed = (await store.listSources()).find((row) => row.id === 'alpha');
    expect(listed).toMatchObject({ state, stateReason: reason, lastTestAt: at(1) });
  });

  it('keeps the newest 50 rows of one source and leaves another source alone', async () => {
    const { database, store } = await openStore();
    for (let minute = 0; minute < 3; minute += 1) await store.recordSourceCheck(checkOf(uuidv7(), pass('beta', at(minute)), null));
    for (let minute = 0; minute < KEPT_CHECKS + 2; minute += 1) await store.recordSourceCheck(checkOf(uuidv7(), pass('alpha', at(minute)), null));
    const counts = await rows(database.ownerUrl, `SELECT source_id, count(*)::int AS kept, min(checked_at) AS oldest FROM source_checks GROUP BY source_id ORDER BY source_id`);
    expect(counts.map((row) => [row['source_id'], row['kept']])).toEqual([['alpha', KEPT_CHECKS], ['beta', 3]]);
    expect(new Date(String(counts[0]?.['oldest'])).toISOString()).toBe(at(2));
  });

  it('follows the newest row by time when runs are stored out of order, and by id when the times are equal', async () => {
    const { store } = await openStore();
    await store.recordSourceCheck(checkOf(uuidv7(), failed(at(5)), null));
    await store.recordSourceCheck(checkOf(uuidv7(), pass('alpha', at(4)), null));
    expect((await store.listSources()).find((row) => row.id === 'alpha')).toMatchObject({ state: 'unavailable', lastTestAt: at(5) });
    const [first, second] = [uuidv7(), uuidv7()].sort();
    if (first === undefined || second === undefined) throw new Error('two ids');
    await store.recordSourceCheck(checkOf(second, failed(at(6)), null));
    await store.recordSourceCheck(checkOf(first, pass('alpha', at(6)), null));
    expect((await store.listSources()).find((row) => row.id === 'alpha')).toMatchObject({ state: 'unavailable' });
  });

  it('is refused with NOT_FOUND for a source that has no row or is marked removed, and nothing is stored', async () => {
    const { database, store } = await openStore();
    await rows(database.ownerUrl, `UPDATE sources SET removed_at = now() WHERE id = 'beta'`);
    expect(await store.hasActiveSource('beta')).toBe(false);
    expect(await store.hasActiveSource('absent')).toBe(false);
    await expect(store.recordSourceCheck(checkOf(uuidv7(), pass('beta', at(1)), null))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await rows(database.ownerUrl, 'SELECT id FROM source_checks')).toEqual([]);
  });
});

describe('the tester and the route over the real database', () => {
  async function appOver(store: AppStore, executor = serverExecutor()) {
    const parts = testSourceGate(mapping, { executor });
    const tester = createSourceTester({ gate: parts.gate, mapping, store, clock: () => Date.now() });
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store, mapping, sourceTester: tester });
    return { app, executor };
  }

  it('does not read a source whose row is removed', async () => {
    const { database, store } = await openStore();
    await rows(database.ownerUrl, `UPDATE sources SET removed_at = now() WHERE id = 'alpha'`);
    const { app, executor } = await appOver(store);
    const response = await app.inject({ method: 'POST', url: '/v1/sources/alpha/test' });
    expect(response.statusCode).toBe(404);
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('answers INTERNAL_ERROR with a trace id and no database detail when the database refuses the write', async () => {
    const { database, store } = await openStore();
    await rows(database.ownerUrl, 'DROP TABLE source_checks');
    const { app } = await appOver(store);
    const response = await app.inject({ method: 'POST', url: '/v1/sources/alpha/test' });
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(body)).not.toMatch(/source_checks|relation|postgres/i);
    expect(response.headers['x-trace-id']).toBe(body.error.traceId);
    await app.close();
  });

  it('shows the state and the time of the last run in GET /v1/sources, and null and unknown before any', async () => {
    const { store } = await openStore();
    const { app } = await appOver(store);
    const before = sourcesResponseSchema.parse((await app.inject({ method: 'GET', url: '/v1/sources' })).json());
    expect(before.items.map((item) => [item.id, item.state, item.lastTestAt])).toEqual([['alpha', 'unknown', null], ['beta', 'unknown', null]]);
    const report = sourceTestReportSchema.parse((await app.inject({ method: 'POST', url: '/v1/sources/alpha/test' })).json());
    const after = sourcesResponseSchema.parse((await app.inject({ method: 'GET', url: '/v1/sources' })).json());
    expect(after.items.map((item) => [item.id, item.state, item.lastTestAt])).toEqual([['alpha', 'connected', report.checkedAt], ['beta', 'unknown', null]]);
    await app.close();
  });

  it('stores one row per call for two calls at once, each started by the local identity', async () => {
    const { database, store } = await openStore();
    const { app } = await appOver(store);
    const [one, two] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/sources/alpha/test' }),
      app.inject({ method: 'POST', url: '/v1/sources/alpha/test' }),
    ]);
    expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
    const stored = await rows(database.ownerUrl, 'SELECT triggered_by FROM source_checks');
    const user = (await store.current()).principal.id;
    expect(stored.map((row) => row['triggered_by'])).toEqual([user, user]);
    await app.close();
  });
});

describe('the in-memory tester used by the other suites', () => {
  it('stores the report it returns', async () => {
    const parts = fakeSourceTester(mapping);
    const report = await parts.tester.run({ traceId: 'tr-test', principal: (await parts.store.current()).principal, sourceId: 'alpha' });
    expect(parts.store.checks.map((check) => check.report)).toEqual([report]);
  });
});
