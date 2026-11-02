import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../db/pool.js';
import { listSourceRows, SYNC_LOCK_KEY, syncSources } from '../db/sources-repository.js';
import { parseMapping } from '../mapping/load.js';
import { runCli } from '../testing/cli.js';
import { forwardTo } from '../testing/forwarder.js';
import { attempt, rows, runInProcess } from '../testing/database.js';
import { baseSource, fileOf, type Json } from '../testing/mapping.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { startApi, stopApi, webRoot } from '../testing/start-api.js';
import { TestExecutor } from '../testing/gate.js';
import { testSourceGate } from '../testing/source-gate.js';
import type { SourceGateOptions } from '../gate/source-gate.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
let postgres: TestPostgres;
const folder = mkdtempSync(join(tmpdir(), 'sources-'));

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await postgres.stop();
  rmSync(webRoot, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

async function migrated(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done;
  expect(result.code).toBe(0);
  return database;
}

let counter = 0;
function mappingFile(...sources: Json[]): string {
  counter += 1;
  const file = join(folder, `neburyx-${counter}.yaml`);
  writeFileSync(file, fileOf(...sources));
  return file;
}

const source = (id: string, overrides: Json = {}): Json => baseSource({ id, ...overrides });
/** What a start whose check does not settle leaves in the row: not checked since the start. */
const NOT_CHECKED = 'The source has not been checked since the start.';

interface Boot {
  readonly logs: string[];
  readonly code: number;
}

/** A gate whose sources never answer in a way that is a verdict, so the startup check does not settle and no check row is stored. */
function unansweringGate(options: SourceGateOptions) {
  const parts = testSourceGate(options.mapping, { executor: new TestExecutor(() => Promise.resolve({ status: 'unavailable', reason: 'closed' })) });
  return { gate: parts.gate, system: parts.system, close: () => Promise.resolve() };
}

async function boot(database: TestDatabase, file: string | undefined, env: Record<string, string> = {}): Promise<Boot> {
  const logs: string[] = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => logs.push(line) });
  const { result } = await startApi(
    { DATABASE_URL: database.appUrl, ...(file === undefined ? {} : { NEBURYX_CONFIG: file }), ...env },
    undefined,
    { logger, openSourceGate: unansweringGate },
  );
  await stopApi(result);
  return { logs, code: result.exitCode };
}

async function sourceRows(database: TestDatabase): Promise<readonly Record<string, unknown>[]> {
  return rows(database.ownerUrl, 'SELECT * FROM sources ORDER BY id');
}

async function rowOf(database: TestDatabase, id: string): Promise<Record<string, unknown>> {
  const [found] = await rows(database.ownerUrl, 'SELECT * FROM sources WHERE id = $1', [id]);
  if (found === undefined) throw new Error(`no row for ${id}`);
  return found;
}

describe('the sources table', () => {
  it('has the columns of the data model and gives the app role read and write rights', async () => {
    const database = await migrated();
    const columns = await rows(database.ownerUrl, `SELECT column_name FROM information_schema.columns WHERE table_name = 'sources'`);
    expect(columns.map((column) => String(column['column_name'])).sort()).toEqual(
      ['alias', 'config_hash', 'connector', 'created_at', 'database', 'id', 'identity_hash', 'removed_at', 'secret_ref', 'state', 'state_reason', 'synthetic', 'updated_at', 'uri'],
    );
    expect(await attempt(database.appUrl, `INSERT INTO sources (id, alias, connector, uri, database, secret_ref, config_hash, identity_hash) VALUES ('x', 'x', 'neo4j', 'u', 'd', 's', 'c', 'i')`)).toBe('allowed');
    expect(await attempt(database.appUrl, `UPDATE sources SET alias = 'y' WHERE id = 'x'`)).toBe('allowed');
    expect(await attempt(database.appUrl, `SELECT * FROM sources`)).toBe('allowed');
  });

  it('refuses a state outside the list and a connector other than neo4j', async () => {
    const database = await migrated();
    const insert = (id: string, connector: string, state: string): Promise<string> =>
      attempt(
        database.ownerUrl,
        `INSERT INTO sources (id, alias, connector, uri, database, secret_ref, config_hash, identity_hash, state) VALUES ($1, $1, $2, 'u', 'd', 's', 'c', 'i', $3)`,
        [id, connector, state],
      );
    expect(await insert('x', 'neo4j', 'disabled')).toContain('sources_state_known');
    expect(await insert('x', 'postgres', 'unknown')).toContain('sources_connector_known');
    for (const state of ['connected', 'degraded', 'unavailable', 'unknown']) expect(await insert(state, 'neo4j', state)).toBe('allowed');
  });

  it('ends with the same table on a fresh database and as an upgrade from the previous migrations', async () => {
    const previous = mkdtempSync(join(folder, 'previous-'));
    for (const name of readdirSync(SHIPPED).filter((file) => file.endsWith('.sql') && file < '0004')) cpSync(join(SHIPPED, name), join(previous, name));
    const upgraded = await postgres.newDatabase();
    const env = { DATABASE_MIGRATION_URL: upgraded.ownerUrl, DATABASE_APP_ROLE: upgraded.appRole };
    expect((await runInProcess(env, previous)).code).toBe(0);
    expect(await rows(upgraded.ownerUrl, `SELECT to_regclass('public.sources') AS found`)).toEqual([{ found: null }]);
    expect((await runInProcess(env, SHIPPED)).code).toBe(0);
    const fresh = await migrated();
    const shape = `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'sources' ORDER BY column_name`;
    expect(await rows(upgraded.ownerUrl, shape)).toEqual(await rows(fresh.ownerUrl, shape));
  });
});

describe('rows at start-up', () => {
  it('writes one row per mapped source with the mapping values, an unknown state and no removal', async () => {
    const database = await migrated();
    const file = mappingFile(source('alpha'), source('beta', { synthetic: true, uri: 'bolt://other.example.test:7687', database: 'second' }));
    expect((await boot(database, file)).code).toBe(0);
    const [alpha, beta] = await sourceRows(database);
    const mapping = parseMapping(fileOf(source('alpha'), source('beta', { synthetic: true, uri: 'bolt://other.example.test:7687', database: 'second' })), 'x');
    expect(alpha).toMatchObject({ id: 'alpha', alias: 'alpha', connector: 'neo4j', uri: 'neo4j+s://graph.example.test:7687', database: 'neo4j', synthetic: false, state: 'unknown', state_reason: NOT_CHECKED, removed_at: null, config_hash: mapping.sources[0]?.configHash });
    expect(beta).toMatchObject({ id: 'beta', uri: 'bolt://other.example.test:7687', database: 'second', synthetic: true, config_hash: mapping.sources[1]?.configHash });
    expect(typeof alpha?.['identity_hash']).toBe('string');
  });

  it('stores the variable names, never the values, and prints neither', async () => {
    const database = await migrated();
    const file = mappingFile(source('alpha'));
    const run = await boot(database, file, { DEMO_USER: 'distinct-user-value', DEMO_PASSWORD: 'distinct-password-value' });
    expect(run.code).toBe(0);
    const all = JSON.stringify(await sourceRows(database));
    expect((await rowOf(database, 'alpha'))['secret_ref']).toBe('DEMO_USER:DEMO_PASSWORD');
    for (const value of ['distinct-user-value', 'distinct-password-value']) {
      expect(all).not.toContain(value);
      expect(run.logs.join('')).not.toContain(value);
    }
  });

  it('keeps one row and the creation time across a restart', async () => {
    const database = await migrated();
    const file = mappingFile(source('alpha'));
    await boot(database, file);
    const first = await rowOf(database, 'alpha');
    await boot(database, file);
    expect(await sourceRows(database)).toHaveLength(1);
    expect(await rowOf(database, 'alpha')).toEqual(first);
  });
});

describe('row updates', () => {
  async function withStateSet(database: TestDatabase): Promise<void> {
    await rows(database.ownerUrl, `UPDATE sources SET state = 'connected', state_reason = 'checked by hand' WHERE id = 'alpha'`);
  }

  it('changes the hash and the update time when the mapped types change, keeps created_at and resets the state, which the start that follows marks as not checked', async () => {
    const database = await migrated();
    await boot(database, mappingFile(source('alpha')));
    await withStateSet(database);
    const before = await rowOf(database, 'alpha');
    await boot(database, mappingFile(source('alpha', { entities: [{ type: 'node_a', label: 'A', stable_id: 'id' }, { type: 'node_b', label: 'B', stable_id: 'key' }, { type: 'node_c', label: 'C', stable_id: 'id' }] })));
    const after = await rowOf(database, 'alpha');
    expect(after['config_hash']).not.toBe(before['config_hash']);
    expect(after['updated_at']).toBeInstanceOf(Date);
    expect(Number(after['updated_at'])).toBeGreaterThan(Number(before['updated_at']));
    expect(after).toMatchObject({ created_at: before['created_at'], state: 'unknown', state_reason: NOT_CHECKED, identity_hash: before['identity_hash'] });
  });

  it('leaves a source alone when another source in the file is edited', async () => {
    const database = await migrated();
    await boot(database, mappingFile(source('alpha'), source('beta')));
    const before = await rowOf(database, 'alpha');
    await boot(database, mappingFile(source('alpha'), source('beta', { synthetic: true })));
    expect(await rowOf(database, 'alpha')).toEqual(before);
    expect((await rowOf(database, 'beta'))['synthetic']).toBe(true);
  });

  it('follows a changed synthetic flag and changed variable names', async () => {
    const database = await migrated();
    await boot(database, mappingFile(source('alpha')));
    const before = await rowOf(database, 'alpha');
    await boot(database, mappingFile(source('alpha', { synthetic: true })));
    const flagged = await rowOf(database, 'alpha');
    expect(flagged).toMatchObject({ synthetic: true });
    expect(flagged['config_hash']).not.toBe(before['config_hash']);
    await boot(database, mappingFile(source('alpha', { synthetic: true, auth: { kind: 'basic', username_env: 'OTHER_USER', password_env: 'OTHER_PASSWORD' } })));
    expect(await rowOf(database, 'alpha')).toMatchObject({ secret_ref: 'OTHER_USER:OTHER_PASSWORD' });
  });

  it('follows a changed address and a changed database', async () => {
    const database = await migrated();
    await boot(database, mappingFile(source('alpha')));
    await boot(database, mappingFile(source('alpha', { uri: 'neo4j+s://moved.example.test:7687' })));
    expect(await rowOf(database, 'alpha')).toMatchObject({ uri: 'neo4j+s://moved.example.test:7687', database: 'neo4j' });
    await boot(database, mappingFile(source('alpha', { uri: 'neo4j+s://moved.example.test:7687', database: 'second' })));
    expect(await rowOf(database, 'alpha')).toMatchObject({ database: 'second' });
  });
});

describe('removal', () => {
  it('keeps the row and marks it removed when the source leaves the file, and keeps the first time', async () => {
    const database = await migrated();
    await boot(database, mappingFile(source('alpha'), source('beta')));
    await boot(database, mappingFile(source('alpha')));
    const first = await rowOf(database, 'beta');
    expect(first['removed_at']).not.toBeNull();
    await boot(database, mappingFile(source('alpha')));
    expect((await rowOf(database, 'beta'))['removed_at']).toEqual(first['removed_at']);
  });

  it('clears the mark when the source returns', async () => {
    const database = await migrated();
    await boot(database, mappingFile(source('alpha'), source('beta')));
    await boot(database, mappingFile(source('alpha')));
    await boot(database, mappingFile(source('alpha'), source('beta')));
    expect((await rowOf(database, 'beta'))['removed_at']).toBeNull();
  });

  it('marks every row removed when no mapping file is set', async () => {
    const database = await migrated();
    await boot(database, mappingFile(source('alpha'), source('beta')));
    await boot(database, undefined);
    const all = await sourceRows(database);
    expect(all).toHaveLength(2);
    expect(all.every((row) => row['removed_at'] !== null)).toBe(true);
  });

  it('leaves a removed source out of the source list and the principal response', async () => {
    const database = await migrated();
    await boot(database, mappingFile(source('alpha'), source('beta')));
    const file = mappingFile(source('alpha'));
    const { result } = await startApi({ DATABASE_URL: database.appUrl, NEBURYX_CONFIG: file });
    if (result.exitCode !== 0) throw new Error('the API did not start');
    try {
      const list = (await result.app.inject({ method: 'GET', url: '/v1/sources' })).json();
      expect(list.items.map((item: { id: string }) => item.id)).toEqual(['alpha']);
      const me = (await result.app.inject({ method: 'GET', url: '/v1/me' })).json();
      expect(me.sources.map((item: { sourceId: string }) => item.sourceId)).toEqual(['alpha']);
    } finally {
      await stopApi(result);
    }
  });
});

describe('the sources endpoints on a started API', () => {
  it('lists the sources with the state a row holds and never the address, database or credential names', async () => {
    const database = await migrated();
    const file = mappingFile(source('alpha'), source('beta', { synthetic: true }));
    const { result } = await startApi({ DATABASE_URL: database.appUrl, NEBURYX_CONFIG: file }, undefined, { openSourceGate: unansweringGate });
    if (result.exitCode !== 0) throw new Error('the API did not start');
    // the list shows what a row holds when it is asked
    await rows(database.ownerUrl, `UPDATE sources SET state = 'unavailable', state_reason = 'TLS handshake failed' WHERE id = 'beta'`);
    try {
      const response = await result.app.inject({ method: 'GET', url: '/v1/sources' });
      expect(response.statusCode).toBe(200);
      expect(response.json().items).toMatchObject([
        { id: 'alpha', state: 'unknown', stateReason: NOT_CHECKED, synthetic: false, readOnly: true, lastTestAt: null },
        { id: 'beta', state: 'unavailable', stateReason: 'TLS handshake failed', synthetic: true },
      ]);
      for (const secret of ['graph.example.test', 'DEMO_USER', 'DEMO_PASSWORD', 'config_hash', 'secret_ref']) expect(response.body).not.toContain(secret);
      const me = (await result.app.inject({ method: 'GET', url: '/v1/me' })).json();
      expect(me.sources).toEqual([
        { sourceId: 'alpha', viewSensitive: true, synthetic: false },
        { sourceId: 'beta', viewSensitive: true, synthetic: true },
      ]);
    } finally {
      await stopApi(result);
    }
  });
});

describe('order and outage', () => {
  it('returns both endpoints in ascending id order even when the file lists them in reverse', async () => {
    const database = await migrated();
    const file = mappingFile(source('charlie'), source('alpha'), source('bravo'));
    const { result } = await startApi({ DATABASE_URL: database.appUrl, NEBURYX_CONFIG: file });
    if (result.exitCode !== 0) throw new Error('the API did not start');
    try {
      const list = (await result.app.inject({ method: 'GET', url: '/v1/sources' })).json();
      expect(list.items.map((item: { id: string }) => item.id)).toEqual(['alpha', 'bravo', 'charlie']);
      const me = (await result.app.inject({ method: 'GET', url: '/v1/me' })).json();
      expect(me.sources.map((item: { sourceId: string }) => item.sourceId)).toEqual(['alpha', 'bravo', 'charlie']);
    } finally {
      await stopApi(result);
    }
  });

  it('answers 500 INTERNAL_ERROR with the trace id and no connection detail while the database stays down', async () => {
    const database = await migrated();
    const forwarder = await forwardTo(database.appUrl);
    const { result } = await startApi({ DATABASE_URL: forwarder.url, NEBURYX_CONFIG: mappingFile(source('alpha')) });
    if (result.exitCode !== 0) throw new Error('the API did not start');
    try {
      await forwarder.stop();
      const response = await result.app.inject({ method: 'GET', url: '/v1/sources' });
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe('INTERNAL_ERROR');
      expect(response.json().error.traceId).toBe(response.headers['x-trace-id']);
      for (const detail of [database.appUrl, 'app-password', new URL(database.appUrl).hostname]) expect(response.body).not.toContain(detail);
    } finally {
      await stopApi(result);
    }
  });
});

describe('deadlines', () => {
  const parsed = (...ids: string[]): ReturnType<typeof parseMapping> => parseMapping(fileOf(...ids.map((id) => source(id))), 'neburyx.yaml');
  const SHORT_MS = 400;

  it('stops a sync that waits for the sync lock longer than its statement timeout, and frees its connection', async () => {
    const database = await migrated();
    const holder = new pg.Client({ connectionString: database.appUrl });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [SYNC_LOCK_KEY]);
    const db = createPool(database.appUrl, () => undefined, { statementTimeoutMs: SHORT_MS, queryTimeoutMs: SHORT_MS * 4, max: 1 });
    try {
      const started = Date.now();
      await expect(syncSources(db, parsed('alpha').sources)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(SHORT_MS * 10);
      await holder.query('SELECT pg_advisory_unlock($1)', [SYNC_LOCK_KEY]);
      await expect(syncSources(db, parsed('alpha').sources)).resolves.toEqual([]);
    } finally {
      await holder.end();
      await db.end();
    }
  });

  it('stops a list read that waits for a table lock longer than its statement timeout', async () => {
    const database = await migrated();
    const holder = new pg.Client({ connectionString: database.ownerUrl });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE sources IN ACCESS EXCLUSIVE MODE');
    const db = createPool(database.appUrl, () => undefined, { statementTimeoutMs: SHORT_MS, queryTimeoutMs: SHORT_MS * 4, max: 1 });
    try {
      const started = Date.now();
      await expect(listSourceRows(db)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(SHORT_MS * 10);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
      await db.end();
    }
  });
});

describe('the sync itself', () => {
  async function pool(database: TestDatabase): Promise<pg.Pool> {
    return createPool(database.appUrl, () => undefined);
  }

  const mapping = (...ids: string[]): ReturnType<typeof parseMapping> => parseMapping(fileOf(...ids.map((id) => source(id))), 'neburyx.yaml');

  it('leaves exactly one row per source when two syncs run at the same time', async () => {
    const database = await migrated();
    const first = await pool(database);
    const second = await pool(database);
    try {
      await Promise.all([syncSources(first, mapping('alpha', 'beta').sources), syncSources(second, mapping('alpha', 'beta').sources)]);
      expect((await sourceRows(database)).map((row) => row['id'])).toEqual(['alpha', 'beta']);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });

  it('rolls everything back when a write fails part-way', async () => {
    const database = await migrated();
    const db = await pool(database);
    try {
      await syncSources(db, mapping('alpha').sources);
      const before = await sourceRows(database);
      const broken = mapping('alpha', 'beta').sources.map((entry) => (entry.id === 'beta' ? { ...entry, auth: { usernameEnv: 'A', passwordEnv: 'B' }, database: 'x'.repeat(10) } : { ...entry, uri: 'neo4j+s://changed.example.test:7687' }));
      await rows(database.ownerUrl, `ALTER TABLE sources ADD CONSTRAINT reject_beta CHECK (id <> 'beta')`);
      await expect(syncSources(db, broken)).rejects.toThrow();
      expect(await sourceRows(database)).toEqual(before);
      expect(await listSourceRows(db)).toHaveLength(1);
    } finally {
      await db.end();
    }
  });

  it('exits 1 with the migrate guidance, no listener and no connection detail when the sources table does not exist yet', async () => {
    const previous = mkdtempSync(join(folder, 'behind-'));
    for (const name of readdirSync(SHIPPED).filter((file) => file.endsWith('.sql') && file < '0004')) cpSync(join(SHIPPED, name), join(previous, name));
    const database = await postgres.newDatabase();
    const env = { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole };
    expect((await runInProcess(env, previous)).code).toBe(0);
    const { result, stderr } = await startApi({ DATABASE_URL: database.appUrl, NEBURYX_CONFIG: mappingFile(source('alpha')) });
    expect(result.exitCode).toBe(1);
    expect('app' in result).toBe(false);
    expect(stderr).toBe('the database schema is behind this version; run neburyx migrate\n');
    expect(stderr).not.toContain(new URL(database.appUrl).hostname);
  });

  it('exits 1 without connection detail and opens no listener when the database cannot be written', async () => {
    const database = await migrated();
    await rows(database.ownerUrl, `ALTER TABLE sources ADD CONSTRAINT reject_all CHECK (false) NOT VALID`);
    const { result, stderr } = await startApi({ DATABASE_URL: database.appUrl, NEBURYX_CONFIG: mappingFile(source('alpha')) });
    expect(result.exitCode).toBe(1);
    expect('app' in result).toBe(false);
    expect(stderr).not.toContain(database.appUrl);
    expect(stderr).not.toContain('app-password');
  });
});

describe('identity changes', () => {
  async function logsOf(database: TestDatabase, file: string): Promise<string> {
    return (await boot(database, file)).logs.join('');
  }

  it('resets the state and writes one event with only the source id when the address changes', async () => {
    const database = await migrated();
    await boot(database, mappingFile(source('alpha')));
    await rows(database.ownerUrl, `UPDATE sources SET state = 'connected', state_reason = 'checked by hand' WHERE id = 'alpha'`);
    const before = await rowOf(database, 'alpha');
    const logs = await logsOf(database, mappingFile(source('alpha', { uri: 'neo4j+s://moved.example.test:7687' })));
    const after = await rowOf(database, 'alpha');
    expect(after['identity_hash']).not.toBe(before['identity_hash']);
    expect(after).toMatchObject({ state: 'unknown', state_reason: NOT_CHECKED });
    const events = logs.split('\n').filter((line) => line.includes('source.identity_changed'));
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0] ?? '{}')).toMatchObject({ sourceId: 'alpha' });
    for (const value of ['moved.example.test', 'graph.example.test', 'neo4j+s']) expect(logs).not.toContain(value);
  });

  it('resets the state and writes the event when the database changes, without naming it', async () => {
    const database = await migrated();
    await boot(database, mappingFile(source('alpha')));
    await rows(database.ownerUrl, `UPDATE sources SET state = 'degraded', state_reason = 'slow' WHERE id = 'alpha'`);
    const hashBefore = (await rowOf(database, 'alpha'))['identity_hash'];
    const logs = await logsOf(database, mappingFile(source('alpha', { database: 'private-database-name' })));
    const changed = await rowOf(database, 'alpha');
    expect(changed).toMatchObject({ state: 'unknown', state_reason: NOT_CHECKED });
    expect(changed['identity_hash']).not.toBe(hashBefore);
    const events = logs.split('\n').filter((line) => line.includes('source.identity_changed'));
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0] ?? '{}')).toMatchObject({ event: 'source.identity_changed', sourceId: 'alpha' });
    expect(logs).not.toContain('private-database-name');
  });

  it('keeps the identity and the log quiet for changes that are not the connection, though a changed mapping resets the state', async () => {
    const database = await migrated();
    await boot(database, mappingFile(source('alpha')));
    await rows(database.ownerUrl, `UPDATE sources SET state = 'connected', state_reason = 'checked by hand' WHERE id = 'alpha'`);
    const before = await rowOf(database, 'alpha');
    const changes: Json[] = [
      { auth: { kind: 'basic', username_env: 'OTHER_USER', password_env: 'OTHER_PASSWORD' } },
      { synthetic: true },
      { entities: [{ type: 'node_a', label: 'A', stable_id: 'id' }, { type: 'node_b', label: 'B', stable_id: 'key' }, { type: 'node_c', label: 'C', stable_id: 'id' }] },
    ];
    let previousHash = before['config_hash'];
    for (const change of changes) {
      const logs = await logsOf(database, mappingFile(source('alpha', change)));
      expect(logs).not.toContain('source.identity_changed');
      const after = await rowOf(database, 'alpha');
      expect(after).toMatchObject({ identity_hash: before['identity_hash'], state: 'unknown', state_reason: NOT_CHECKED });
      expect(after['config_hash']).not.toBe(previousHash);
      previousHash = after['config_hash'];
    }
  });

  it('gives two sources with the same connection the same identity hash', async () => {
    const database = await migrated();
    await boot(database, mappingFile(source('alpha'), source('beta')));
    const [alpha, beta] = await sourceRows(database);
    expect(alpha?.['identity_hash']).toBe(beta?.['identity_hash']);
  });

  it('keeps the identity and writes no event when a removed source returns with the same connection', async () => {
    const database = await migrated();
    await boot(database, mappingFile(source('alpha'), source('beta')));
    const before = await rowOf(database, 'beta');
    await boot(database, mappingFile(source('alpha')));
    const logs = await logsOf(database, mappingFile(source('alpha'), source('beta')));
    expect((await rowOf(database, 'beta'))['identity_hash']).toBe(before['identity_hash']);
    expect(logs).not.toContain('source.identity_changed');
  });
});
