import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assembleGate } from '../gate/assemble.js';
import type { SourceGateOptions } from '../gate/source-gate.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { memoryAppStore, memoryStoreWith, type MemoryAppStore } from '../testing/app-store.js';
import { fakeDrivers, neo4jError, type FakeBehaviour } from '../testing/fake-source-driver.js';
import { sourceWith } from '../testing/gate-fixtures.js';
import { fileOf } from '../testing/mapping.js';
import { SERVER_ROW } from '../testing/source-tester.js';
import { runTestSourceCommand, type CommandStore, type TestSourceIo } from './command.js';

const folder = mkdtempSync(join(tmpdir(), 'test-source-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const DATABASE_URL = 'postgres://app_user:MARKER_DB_PASSWORD@db.example.test:5432/neburyx';
const AUTH = { kind: 'basic', username_env: 'MARKER_USER_VAR', password_env: 'MARKER_PASS_VAR' };
const SOURCE_ENV = { MARKER_USER_VAR: 'MARKER_USER_VALUE', MARKER_PASS_VAR: 'MARKER_PASS_VALUE' };
const URI = 'neo4j+s://MARKER_HOST.example.test:7687';

let counter = 0;
function mappingFile(...ids: string[]): string {
  counter += 1;
  const file = join(folder, `neburyx-${counter}.yaml`);
  writeFileSync(file, fileOf(...ids.map((id) => sourceWith(id, { uri: URI, auth: AUTH }))));
  return file;
}

const env = (extra: Record<string, string | undefined> = {}) => ({ DATABASE_URL, NEBURYX_CONFIG: mappingFile('alpha', 'beta'), ...SOURCE_ENV, ...extra });
interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly store: MemoryAppStore;
  readonly fake: ReturnType<typeof fakeDrivers>;
}

async function run(args: readonly string[], environment: Record<string, string | undefined>, behaviour: FakeBehaviour = { rows: [SERVER_ROW] }, overrides: Partial<TestSourceIo> = {}, seams: Partial<Seams> = {}, store: MemoryAppStore = memoryAppStore()): Promise<Run> {
  let out = '';
  let err = '';
  const fake = fakeDrivers(behaviour);
  const code = await runTestSourceCommand(args, environment, {
    stdout: { write: (text) => (out += text) },
    stderr: { write: (text) => (err += text) },
    clock: () => Date.UTC(2026, 10, 2, 10, 0, 0),
    openStore: () => store,
    openSourceGate: (options: SourceGateOptions) => {
      const executor = createNeo4jExecutor({ sources: options.mapping.sources, env: options.env, logger: options.logger, createDriver: fake.factory });
      const defaults = communitySeams();
      const parts = assembleGate({ mapping: options.mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit, ...seams }, executor, logger: options.logger });
      return { ...parts, close: () => executor.close() };
    },
    ...overrides,
  });
  return { code, out, err, store, fake };
}

describe('a usage error', () => {
  it.each([[[]], [['--name']], [['--write-probe']], [['--name', 'alpha', 'extra']]])('prints the usage on stderr and exits 2 for %j', async (args) => {
    const result = await run(args, env());
    expect(result.code).toBe(2);
    expect(result.err).toBe('usage: neburyx test-source --name <source>\n');
    expect(result.out).toBe('');
    expect(result.fake.drivers).toEqual([]);
  });
});

describe('a source that answers', () => {
  it('prints plain lines with the server, the verdict, the operations, the mapping counts and the time, and exits 0', async () => {
    const result = await run(['--name', 'alpha'], env());
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain('Source: alpha\nOutcome: pass\nState: connected\nServer: Neo4j Kernel 5.26.32 (community)\nVersion supported: yes\n');
    expect(result.out).toContain('Operations: execute (supported), searchEntities (by-template)');
    expect(result.out).toContain('Mapping: 2 entity types, 2 relationship types, 0 derived rules\nRead-only: not verified\nChecked at: 2026-11-02T10:00:00.000Z\n');
    expect(result.store.checks).toHaveLength(1);
    expect(result.fake.drivers[0]?.closeCalls).toBe(1);
    expect(result.store.checks[0]).toMatchObject({ triggeredBy: (await result.store.current()).principal.id });
  });

  it('exits 0 and prints the reason for a version outside the support matrix', async () => {
    const result = await run(['--name', 'alpha'], env(), { rows: [{ ...SERVER_ROW, version: '4.4.0' }] });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Outcome: warn\nState: degraded\nReason: The server version is not on the support matrix.\n');
  });

  it('sees one read transaction in read mode with the capabilities Cypher and nothing else', async () => {
    const result = await run(['--name', 'alpha'], env());
    expect(result.fake.drivers).toHaveLength(1);
    const sessions = result.fake.drivers[0]?.sessions ?? [];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.config.defaultAccessMode).toBe('READ');
    expect(sessions[0]?.begins).toHaveLength(1);
    expect(sessions[0]?.queries.map((query) => query.cypher)).toEqual(["CALL dbms.components() YIELD name, versions, edition WHERE name = 'Neo4j Kernel' RETURN name, versions[0] AS version, edition"]);
    expect(result.fake.forbidden).toEqual([]);
  });
});

describe('a source that does not answer', () => {
  it('prints the fixed reason and exits 1', async () => {
    const result = await run(['--name', 'alpha'], env(), { beginError: neo4jError('ServiceUnavailable', 'MARKER_MESSAGE') });
    expect(result.code).toBe(1);
    expect(result.out).toContain('Outcome: fail\nState: unavailable\nReason: The source could not be reached.\nServer: not reached\nVersion supported: unknown\nOperations: none\n');
    expect(result.out + result.err).not.toContain('MARKER');
  });
});

describe('a run that is not a verdict about the source', () => {
  it.each([
    ['a busy source', { coordinator: { acquireRead: () => Promise.resolve({ status: 'busy' as const }) } }, 'the source is busy; try again shortly\n'],
    ['a policy that denies', { policy: { authorizeSource: () => Promise.resolve({ allowed: false as const, reason: 'denied' }) } }, 'you are not allowed to test this source\n'],
    ['a coordinator that refuses', { coordinator: { acquireRead: () => Promise.resolve({ status: 'unavailable' as const }) } }, 'the source could not be tested; try again\n'],
  ])('prints one plain line for %s and exits 1', async (_name, seams, line) => {
    const result = await run(['--name', 'alpha'], env(), { rows: [SERVER_ROW] }, {}, seams);
    expect(result.code).toBe(1);
    expect(result.err).toBe(line);
    expect(result.out).toBe('');
    expect(result.store.checks).toEqual([]);
  });

  it('prints one plain line for a full pool and for an unexpected error', async () => {
    const full = await run(['--name', 'alpha'], env(), { beginError: neo4jError('N/A', 'Connection acquisition timed out in 2000 ms.') });
    expect([full.code, full.err]).toEqual([1, 'the source could not be tested; try again\n']);
    const odd = await run(['--name', 'alpha'], env(), { beginError: neo4jError('Neo.ClientError.Statement.SyntaxError', 'MARKER_MESSAGE') });
    expect([odd.code, odd.err]).toEqual([1, 'the source could not be tested; try again\n']);
  });
});

describe('a configuration or database problem', () => {
  it('exits 2 for a name that is not configured and lists the configured ids', async () => {
    const result = await run(['--name', 'gamma'], env());
    expect(result.code).toBe(2);
    expect(result.err).toBe('no source named gamma is configured; configured sources: alpha, beta\n');
  });

  it('exits 1 with its own message when NEBURYX_CONFIG is not set', async () => {
    const result = await run(['--name', 'alpha'], env({ NEBURYX_CONFIG: undefined }));
    expect([result.code, result.err]).toEqual([1, 'test-source needs NEBURYX_CONFIG, the path of the mapping file\n']);
  });

  it('exits 1 with the configuration message for DATABASE_URL, and for a bad one', async () => {
    expect((await run(['--name', 'alpha'], env({ DATABASE_URL: undefined }))).err).toBe('invalid configuration: DATABASE_URL\n');
    expect((await run(['--name', 'alpha'], env({ DATABASE_URL: 'mysql://x' }))).err).toBe('invalid configuration: DATABASE_URL\n');
  });

  it('exits 1 with the message of the loader for an invalid mapping, naming no value', async () => {
    const file = join(folder, 'broken.yaml');
    writeFileSync(file, 'sources: [');
    const result = await run(['--name', 'alpha'], env({ NEBURYX_CONFIG: file }));
    expect(result.code).toBe(1);
    expect(result.err.length).toBeGreaterThan(0);
    expect(result.fake.drivers).toEqual([]);
  });

  it.each([
    ['ECONNREFUSED', undefined, 'the database could not be reached\n'],
    ['ECONNRESET', undefined, 'the database could not be reached\n'],
    ['57P01', undefined, 'the database could not be reached\n'],
    ['28P01', undefined, 'the database could not be reached\n'],
    [undefined, 'timeout exceeded when trying to connect', 'the database could not be reached\n'],
    ['42P01', undefined, 'the database schema is behind this version; run neburyx migrate\n'],
  ])('exits 1 with a plain line when the database fails with code %s and message %s, with no connection detail', async (code, text, line) => {
    const failure = Object.assign(new Error(text ?? 'MARKER_DB_PASSWORD at db.example.test'), code === undefined ? {} : { code });
    const store: CommandStore = { ...memoryAppStore(), current: () => Promise.reject(failure) };
    const result = await run(['--name', 'alpha'], env(), { rows: [SERVER_ROW] }, { openStore: () => store });
    expect([result.code, result.err]).toEqual([1, line]);
    expect(result.err).not.toContain('MARKER');
  });

  it('exits 1 and says the API must be started once when the local identity is missing', async () => {
    const store: CommandStore = { ...memoryAppStore(), current: () => Promise.reject(new Error('the deployment row or the local user is missing')) };
    const result = await run(['--name', 'alpha'], env(), { rows: [SERVER_ROW] }, { openStore: () => store });
    expect([result.code, result.err]).toEqual([1, 'the local identity is missing; start the API once so that it creates it\n']);
  });

  it('exits 1 and says the API must be started once when the source has no row or is removed', async () => {
    const store = memoryStoreWith({ inactiveSources: ['alpha'] });
    const result = await run(['--name', 'alpha'], env(), { rows: [SERVER_ROW] }, {}, {}, store);
    expect([result.code, result.err]).toEqual([1, 'the database does not know this source yet; start the API once so that it creates the local identity and the sources\n']);
    expect(result.fake.drivers).toEqual([]);
  });

  it('closes the gate and the store on every path', async () => {
    const closed: string[] = [];
    const store: CommandStore = { ...memoryAppStore(), close: () => (closed.push('store'), Promise.resolve()) };
    const result = await run(['--name', 'alpha'], env(), { beginError: neo4jError('Neo.ClientError.Statement.SyntaxError', 'x') }, { openStore: () => store });
    expect(closed).toEqual(['store']);
    expect(result.fake.drivers[0]?.closeCalls).toBe(1);
  });
});
