import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sourcesResponseSchema, type SourceTestReport } from '@neburyx/contracts';
import { buildApp } from '../app.js';
import { createAppStore, type AppStore } from '../app-store.js';
import { assembleGate } from '../gate/assemble.js';
import type { SourceGateOptions } from '../gate/source-gate.js';
import { uuidv7 } from '../identity/uuid.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { communitySeams } from '../seams/community-seams.js';
import { runCli } from '../testing/cli.js';
import { rows, runInProcess } from '../testing/database.js';
import { fakeDrivers } from '../testing/fake-source-driver.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { fileOf } from '../testing/mapping.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { SERVER_ROW } from '../testing/source-tester.js';
import { webRoot } from '../testing/start-api.js';
import { reportFromFailure, reportFromServer } from '../source-test/report.js';
import { runTestSourceCommand } from '../source-test/command.js';
import { FAILURE_SENTENCES } from '../source-test/reasons.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const mapping = mappingOf(sourceWith('alpha'));
const [alpha] = mapping.sources;
if (alpha === undefined) throw new Error('the fixture mapping has a source');
const folder = mkdtempSync(join(tmpdir(), 'ping-state-'));

let postgres: TestPostgres;
const stores: AppStore[] = [];
beforeAll(async () => {
  postgres = await startPostgres();
});
afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await postgres.stop();
  rmSync(folder, { recursive: true, force: true });
  rmSync(webRoot, { recursive: true, force: true });
});

async function open(): Promise<{ readonly database: TestDatabase; readonly store: AppStore }> {
  const database = await postgres.newDatabase();
  const migrated = await runInProcess({ DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }, SHIPPED);
  expect(migrated.code, migrated.stderr).toBe(0);
  const opened = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
  let closing: Promise<void> | undefined;
  const store: AppStore = { ...opened, close: () => (closing ??= opened.close()) };
  stores.push(store);
  await store.initialize();
  await store.syncSources(mapping.sources);
  return { database, store };
}

const CAPS = { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community', versionSupported: true, operations: [] };
const at = (minute: number): string => new Date(Date.UTC(2026, 10, 2, 10, minute, 0)).toISOString();
const pass = (minute = 1): SourceTestReport => reportFromServer(alpha, CAPS, null, at(minute));
const warn = (minute = 1): SourceTestReport => reportFromServer(alpha, { ...CAPS, versionSupported: false }, null, at(minute));
const fail = (minute = 1): SourceTestReport => reportFromFailure(alpha, 'unreachable', at(minute));
const test = (store: AppStore, report: SourceTestReport, identityHash = identityHashOf(alpha)) => store.recordSourceCheck({ id: uuidv7(), report, triggeredBy: null, identityHash });
const NEVER_DROPPED = '2099-01-01T00:00:00.000Z';
const ping = (store: AppStore, reachable: boolean, observedAt = NEVER_DROPPED) =>
  store.applyPingState({ sourceId: 'alpha', reachable, reason: reachable ? null : FAILURE_SENTENCES.unreachable, observedAt });
const stateOf = async (database: TestDatabase) => (await rows(database.ownerUrl, `SELECT state, state_reason FROM sources WHERE id = 'alpha'`))[0];
const UNREACHABLE = { state: 'unavailable', state_reason: FAILURE_SENTENCES.unreachable };

describe('the migration', () => {
  it('adds a nullable identity_hash to source_checks, and a second run changes nothing', async () => {
    const database = await postgres.newDatabase();
    const env = { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };
    for (let run = 0; run < 2; run += 1) {
      const result = await runCli(['migrate'], env).done;
      expect(result.code, result.stderr).toBe(0);
    }
    expect(await rows(database.ownerUrl, `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'source_checks' AND column_name = 'identity_hash'`)).toEqual([{ is_nullable: 'YES' }]);
  });

  it('is stored with a run, naming the connection that was tested', async () => {
    const { database, store } = await open();
    await test(store, pass());
    expect(await rows(database.ownerUrl, 'SELECT identity_hash FROM source_checks')).toEqual([{ identity_hash: identityHashOf(alpha) }]);
  });
});

describe('a ping after a pass', () => {
  it('marks the source unavailable with the sentence when it fails, and connected again when it succeeds', async () => {
    const { database, store } = await open();
    await test(store, pass());
    expect(await ping(store, false)).toBe(true);
    expect(await stateOf(database)).toEqual(UNREACHABLE);
    expect(await ping(store, true)).toBe(true);
    expect(await stateOf(database)).toEqual({ state: 'connected', state_reason: null });
  });
});

describe('a ping after a warn or a fail', () => {
  it('goes unavailable with the ping sentence and back to degraded with the test reason', async () => {
    const { database, store } = await open();
    await test(store, warn());
    await ping(store, false);
    expect(await stateOf(database)).toEqual(UNREACHABLE);
    await ping(store, true);
    expect(await stateOf(database)).toEqual({ state: 'degraded', state_reason: 'The server version is not on the support matrix.' });
  });

  it('leaves unavailable with the test reason when the last test failed', async () => {
    const { database, store } = await open();
    await test(store, reportFromFailure(alpha, 'authentication', at(1)));
    expect(await ping(store, true)).toBe(false);
    expect(await stateOf(database)).toEqual({ state: 'unavailable', state_reason: FAILURE_SENTENCES.authentication });
  });

  it('keeps a source that was down at start-up unavailable with the test sentence while its pings succeed', async () => {
    const { database, store } = await open();
    await test(store, fail());
    for (let run = 0; run < 3; run += 1) await ping(store, true);
    expect(await stateOf(database)).toEqual({ state: 'unavailable', state_reason: FAILURE_SENTENCES.unreachable });
  });
});

describe('a source that was never tested, or tested against another connection', () => {
  it('is unavailable after a failed ping and unknown with no reason after a successful one', async () => {
    const { database, store } = await open();
    await ping(store, false);
    expect(await stateOf(database)).toEqual(UNREACHABLE);
    await ping(store, true);
    expect(await stateOf(database)).toEqual({ state: 'unknown', state_reason: null });
  });

  it.each([
    ['a test written long after', at(0 + 59)],
    ['a test written long before', '2001-01-01T00:00:00.000Z'],
  ])('does not take the state of a test of another connection, whatever the clock of %s says', async (_name, checkedAt) => {
    const { database, store } = await open();
    await test(store, { ...pass(), checkedAt }, 'another-connection');
    await ping(store, true);
    expect(await stateOf(database)).toEqual({ state: 'unknown', state_reason: null });
    await test(store, { ...warn(), checkedAt });
    await ping(store, false);
    await ping(store, true);
    expect(await stateOf(database)).toMatchObject({ state: 'degraded' });
  });

  it('does not take the result of a command run against a re-pointed mapping while the API still uses the old connection', async () => {
    const { database, store } = await open();
    const file = join(folder, 'repointed.yaml');
    writeFileSync(file, fileOf(sourceWith('alpha', { uri: 'neo4j+s://elsewhere.example.test:7687' })));
    const fake = fakeDrivers({ rows: [SERVER_ROW] });
    let out = '';
    const code = await runTestSourceCommand(['--name', 'alpha'], { DATABASE_URL: database.appUrl, NEBURYX_CONFIG: file, DEMO_USER: 'u', DEMO_PASSWORD: 'p' }, {
      stdout: { write: (text) => (out += text) },
      stderr: { write: () => undefined },
      openStore: () => ({ ...store, close: () => Promise.resolve() }),
      openSourceGate: (options: SourceGateOptions) => {
        const executor = createNeo4jExecutor({ sources: options.mapping.sources, env: options.env, logger: options.logger, createDriver: fake.factory });
        const defaults = communitySeams();
        const parts = assembleGate({ mapping: options.mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger: options.logger });
        return { ...parts, close: () => executor.close() };
      },
    });
    expect(code).toBe(0);
    expect(out).toContain('Outcome: pass');
    expect(await stateOf(database)).toEqual({ state: 'connected', state_reason: null });
    await ping(store, false);
    await ping(store, true);
    expect(await stateOf(database)).toEqual({ state: 'unknown', state_reason: null });
  });
});

describe('what a ping writes', () => {
  async function version(database: TestDatabase) {
    return (await rows(database.ownerUrl, `SELECT xmin::text AS version, updated_at FROM sources WHERE id = 'alpha'`))[0];
  }

  it('issues no update when the state already is what the ping implies, and never touches updated_at', async () => {
    const { database, store } = await open();
    await test(store, pass());
    await ping(store, true);
    const before = await version(database);
    expect(await ping(store, true)).toBe(false);
    expect(await version(database)).toEqual(before);
    await ping(store, false);
    const unavailable = await version(database);
    expect(unavailable?.['updated_at']).toEqual(before?.['updated_at']);
    expect(await ping(store, false)).toBe(false);
    expect(await version(database)).toEqual(unavailable);
  });

  it('writes nothing in source_checks', async () => {
    const { database, store } = await open();
    await ping(store, false);
    await ping(store, true);
    expect(await rows(database.ownerUrl, 'SELECT id FROM source_checks')).toEqual([]);
  });

  it('writes nothing for a source whose row is marked removed or is missing', async () => {
    const { database, store } = await open();
    await rows(database.ownerUrl, `UPDATE sources SET removed_at = now() WHERE id = 'alpha'`);
    const before = await version(database);
    expect(await ping(store, false)).toBe(false);
    expect(await store.applyPingState({ sourceId: 'absent', reachable: false, reason: 'x', observedAt: NEVER_DROPPED })).toBe(false);
    expect(await version(database)).toEqual(before);
    expect(await stateOf(database)).toEqual({ state: 'unknown', state_reason: null });
  });
});

describe('GET /v1/sources', () => {
  it('shows the state and reason the pings left', async () => {
    const { store } = await open();
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store, mapping });
    await test(store, pass());
    await ping(store, false);
    const down = sourcesResponseSchema.parse((await app.inject({ method: 'GET', url: '/v1/sources' })).json());
    expect(down.items.map((item) => [item.id, item.state, item.stateReason])).toEqual([['alpha', 'unavailable', FAILURE_SENTENCES.unreachable]]);
    await ping(store, true);
    const up = sourcesResponseSchema.parse((await app.inject({ method: 'GET', url: '/v1/sources' })).json());
    expect(up.items.map((item) => [item.id, item.state, item.stateReason])).toEqual([['alpha', 'connected', null]]);
    await app.close();
  });
});

describe('a ping and a test that meet', () => {
  it('gives way to a test that was reached after its read started, even when the test committed first', async () => {
    const { database, store } = await open();
    await test(store, pass(5));
    expect(await ping(store, false, at(4))).toBe(false);
    expect(await stateOf(database)).toEqual({ state: 'connected', state_reason: null });
    expect(await ping(store, false, at(6))).toBe(true);
    expect(await stateOf(database)).toEqual(UNREACHABLE);
  });

  it('is overwritten by a test that was reached before its read started but committed after it, until the next ping writes again', async () => {
    const { database, store } = await open();
    await test(store, pass(1));
    await ping(store, false, at(3));
    expect(await stateOf(database)).toEqual(UNREACHABLE);
    await test(store, pass(2));
    expect(await stateOf(database)).toEqual({ state: 'connected', state_reason: null });
    await ping(store, false, at(4));
    expect(await stateOf(database)).toEqual(UNREACHABLE);
  });

  it('loses at most one interval to a clock of the test that runs ahead by less than one interval', async () => {
    const { database, store } = await open();
    const observed = Date.UTC(2026, 10, 2, 10, 5, 0);
    await test(store, { ...pass(), checkedAt: new Date(observed + 10_000).toISOString() });
    await ping(store, false, new Date(observed).toISOString());
    expect(await stateOf(database)).toEqual({ state: 'connected', state_reason: null });
    await ping(store, false, new Date(observed + 30_000).toISOString());
    expect(await stateOf(database)).toEqual(UNREACHABLE);
  });

  it('ends with the state of the test when both run at the same time, and writes no check of its own', async () => {
    const { database, store } = await open();
    await Promise.all([test(store, pass(5)), ping(store, false, at(4))]);
    expect(await stateOf(database)).toEqual({ state: 'connected', state_reason: null });
    expect((await rows(database.ownerUrl, 'SELECT id FROM source_checks')).length).toBe(1);
  });
});

describe('a ping and a test that wait for the same row lock', () => {
  async function holdLock(database: TestDatabase): Promise<pg.Client> {
    const owner = new pg.Client({ connectionString: database.ownerUrl });
    await owner.connect();
    await owner.query('BEGIN');
    await owner.query(`SELECT 1 FROM sources WHERE id = 'alpha' FOR UPDATE`);
    return owner;
  }

  async function waitUntilBlocked(database: TestDatabase, count: number): Promise<void> {
    await vi.waitFor(
      async () => {
        const name = new URL(database.ownerUrl).pathname.slice(1);
        const [blocked] = await rows(database.adminUrl, `SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [name]);
        expect(blocked?.['blocked']).toBe(count);
      },
      { timeout: 5000, interval: 25 },
    );
  }

  it('drops the change of a failed ping that was waiting while a test, reached later, committed', async () => {
    const { database, store } = await open();
    const owner = await holdLock(database);
    try {
      const pinging = ping(store, false, at(4));
      await waitUntilBlocked(database, 1);
      await owner.query(
        `INSERT INTO source_checks (id, source_id, checked_at, outcome, read_only_check, report, identity_hash) VALUES ($1, 'alpha', $2, 'pass', 'not-verified', $3, $4)`,
        [uuidv7(), at(5), JSON.stringify(pass(5)), identityHashOf(alpha)],
      );
      await owner.query(`UPDATE sources SET state = 'connected', state_reason = NULL WHERE id = 'alpha'`);
      await owner.query('COMMIT');
      expect(await pinging).toBe(false);
    } finally {
      await owner.end();
    }
    expect(await stateOf(database)).toEqual({ state: 'connected', state_reason: null });
  });

  it('lets a test that waited behind a ping write after it, and the next ping writes again', async () => {
    const { database, store } = await open();
    const owner = await holdLock(database);
    try {
      const testing = test(store, pass(2));
      await waitUntilBlocked(database, 1);
      await owner.query(`UPDATE sources SET state = 'unavailable', state_reason = $1 WHERE id = 'alpha'`, [FAILURE_SENTENCES.unreachable]);
      await owner.query('COMMIT');
      await testing;
    } finally {
      await owner.end();
    }
    expect(await stateOf(database)).toEqual({ state: 'connected', state_reason: null });
    await ping(store, false, at(4));
    expect(await stateOf(database)).toEqual(UNREACHABLE);
  });

  it('serves a ping and a test that both wait in the order they arrived, with the state of the test at the end', async () => {
    const { database, store } = await open();
    const owner = await holdLock(database);
    try {
      const testing = test(store, pass(5));
      await waitUntilBlocked(database, 1);
      const pinging = ping(store, false, at(4));
      await waitUntilBlocked(database, 2);
      await owner.query('COMMIT');
      await Promise.all([testing, pinging]);
    } finally {
      await owner.end();
    }
    expect(await stateOf(database)).toEqual({ state: 'connected', state_reason: null });
    expect((await rows(database.ownerUrl, 'SELECT id FROM source_checks')).length).toBe(1);
  });
});
