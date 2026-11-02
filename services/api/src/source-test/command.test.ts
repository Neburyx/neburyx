import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { ALWAYS_USABLE } from '../testing/usability.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assembleGate } from '../gate/assemble.js';
import type { SourceGateOptions } from '../gate/source-gate.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { memoryAppStore, memoryStoreWith, type MemoryAppStore } from '../testing/app-store.js';
import { fakeProbeDriver, type FakeProbeBehaviour } from '../testing/fake-probe-driver.js';
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
      const parts = assembleGate({ usability: ALWAYS_USABLE, mapping: options.mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit, ...seams }, executor, logger: options.logger });
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
    expect(result.err).toBe('usage: neburyx test-source --name <source> [--write-probe]\n');
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
    expect(result.out).toContain('Mapping: 2 entity types, 2 relationship types, 0 derived rules\nRead-only: not verified\nLogin can write: unknown\nMapping checks: pass\nChecked at: 2026-11-02T10:00:00.000Z\n');
    expect(result.store.checks).toHaveLength(1);
    expect(result.fake.drivers[0]?.closeCalls).toBe(1);
    expect(result.store.checks[0]).toMatchObject({ triggeredBy: (await result.store.current()).principal.id });
  });

  it('prints that the privileges were inspected and the login cannot write, for a listing with no right beyond reading', async () => {
    const result = await run(['--name', 'alpha'], env(), { rows: [SERVER_ROW], privileges: [] });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Outcome: pass\nState: connected\n');
    expect(result.out).toContain('Read-only: privileges inspected\nLogin can write: no\nMapping checks: pass\nChecked at:');
  });

  it('exits 0 and prints the fixed reason and that the login can write, for a listing that grants a write right', async () => {
    const result = await run(['--name', 'alpha'], env(), { rows: [SERVER_ROW], privileges: [{ access: 'GRANTED', action: 'write', resource: 'graph', graph: '*', segment: 'NODE(*)' }] });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Outcome: warn\nState: degraded\nReason: The login can write to the source; give Neburyx a login that can only read.\n');
    expect(result.out).toContain('Read-only: privileges inspected\nLogin can write: yes\n');
  });

  it('exits 0 and prints the reason for a version outside the support matrix', async () => {
    const result = await run(['--name', 'alpha'], env(), { rows: [{ ...SERVER_ROW, version: '4.4.0' }] });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Outcome: warn\nState: degraded\nReason: The server version is not on the support matrix.\n');
  });

  it('sees four read transactions in read mode, one for each of the capabilities, the privileges, the labels and types and the indexes, and nothing else', async () => {
    const result = await run(['--name', 'alpha'], env());
    expect(result.fake.drivers).toHaveLength(1);
    const sessions = result.fake.drivers[0]?.sessions ?? [];
    expect(sessions).toHaveLength(4);
    for (const session of sessions) {
      expect(session.config.defaultAccessMode).toBe('READ');
      expect(session.begins).toHaveLength(1);
    }
    expect(sessions.flatMap((session) => session.queries.map((query) => query.cypher))).toEqual([
      "CALL dbms.components() YIELD name, versions, edition WHERE name = 'Neo4j Kernel' RETURN name, versions[0] AS version, edition",
      "SHOW USER PRIVILEGES YIELD access, action, resource, graph, segment WHERE NOT action IN ['access', 'traverse', 'read', 'match', 'execute', 'execute_function', 'load', 'show_index', 'show_constraint'] RETURN DISTINCT access, action, resource, graph, segment LIMIT $limit + 1",
      'CALL { CALL db.labels() YIELD label RETURN collect(label) AS labels } CALL { CALL db.relationshipTypes() YIELD relationshipType RETURN collect(relationshipType) AS types } RETURN [l IN $mappedLabels WHERE l IN labels] AS labels, [t IN $mappedTypes WHERE t IN types] AS types',
      "SHOW INDEXES YIELD type, entityType, labelsOrTypes, properties, state, owningConstraint WHERE type IN ['RANGE', 'TEXT'] AND labelsOrTypes[0] IN ($mappedLabels + $mappedTypes) AND properties[0] IN $mappedProperties RETURN collect({type: type, entityType: entityType, name: labelsOrTypes[0], property: properties[0], single: size(properties) = 1, state: state, constrained: owningConstraint IS NOT NULL})[..500] AS indexes, count(*) > 500 AS truncated",
    ]);
    expect(result.fake.forbidden).toEqual([]);
  });
});

describe('the record the command hands its gate', () => {
  it('has every source unchecked, because the command runs system-scope templates only', async () => {
    let handed: SourceGateOptions['usability'] | undefined;
    await run(['--name', 'alpha'], env(), { rows: [SERVER_ROW] }, {
      openSourceGate: (options: SourceGateOptions) => {
        handed = options.usability;
        const executor = createNeo4jExecutor({ sources: options.mapping.sources, env: options.env, logger: options.logger, createDriver: fakeDrivers({ rows: [SERVER_ROW] }).factory });
        const defaults = communitySeams();
        const parts = assembleGate({ usability: options.usability, mapping: options.mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger: options.logger });
        return { ...parts, close: () => executor.close() };
      },
    });
    expect([handed?.isUsable('alpha'), handed?.isUsable('beta')]).toEqual([false, false]);
  });
});

describe('the mapping checks in the output', () => {
  it('prints that they pass, and a line for each finding with its severity and message when they do not', async () => {
    const fits = await run(['--name', 'alpha'], env());
    expect(fits.out).toContain('Mapping checks: pass\nChecked at:');
    const wrong = await run(['--name', 'alpha'], env(), { rows: [SERVER_ROW], schemaTokens: [{ labels: [], types: [] }] });
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain('Outcome: fail\nState: unavailable\nReason: The mapping does not fit the source: ');
    expect(wrong.out).toContain('Mapping checks: fail\n  fail: Entity type "person" (label "Person"): no node carries the label\n  fail: Entity type "order_line" (label "Order Line"): no node carries the label\n');
    expect(wrong.out).toContain('  fail: Relationship type "KNOWS" from "person" to "person": no relationship of the type exists\n');
    expect(wrong.store.checks).toHaveLength(1);
  });

  it('prints not verified for a login that may not list indexes, and not run for a source that did not answer', async () => {
    const refused = await run(['--name', 'alpha'], env(), { rows: [SERVER_ROW], schemaError: { read: 'indexes', error: neo4jError('Neo.ClientError.Security.Forbidden') } });
    expect(refused.code).toBe(0);
    expect(refused.out).toContain('Mapping checks: not verified\n  warn: The index checks were not verified because the login may not list indexes (grant SHOW INDEX and SHOW CONSTRAINT); a search on this source may scan.\n');
    const down = await run(['--name', 'alpha'], env(), { beginError: neo4jError('ServiceUnavailable') });
    expect(down.out).toContain('Mapping checks: not run\n');
  });

  it('says the source could not be tested, and stores nothing, when a schema read times out', async () => {
    const result = await run(['--name', 'alpha'], env(), { rows: [SERVER_ROW], schemaError: { read: 'tokens', error: neo4jError('Neo.ClientError.Transaction.TransactionTimedOut') } });
    expect([result.code, result.err, result.out]).toEqual([1, 'the source did not answer in time; try again\n', '']);
    expect(result.store.checks).toEqual([]);
  });
});

describe('the write probe flag', () => {
  const READ_ONLY = { rows: [SERVER_ROW], privileges: [] };
  const probeRun = (args: readonly string[], probe: FakeProbeBehaviour = {}, behaviour: FakeBehaviour = READ_ONLY) => {
    const probes = fakeProbeDriver(probe);
    return run(args, env(), behaviour, { openProbeDriver: probes.factory }).then((result) => ({ ...result, probes }));
  };

  it.each([[['--name', 'alpha', '--write-probe']], [['--write-probe', '--name', 'alpha']]])('runs the probe with %j and says so on stderr before it opens the transaction', async (args) => {
    const result = await probeRun(args);
    expect(result.err).toBe('write probe: opening a write transaction on source alpha and rolling it back\n');
    expect(result.probes.sessions).toHaveLength(1);
    expect(result.probes.sessions[0]?.statements).toEqual(['CREATE () RETURN 1 AS probe']);
    expect(result.probes.sessions[0]?.rollbacks).toBe(1);
    expect(result.probes.forbidden).toEqual([]);
  });

  it('runs no probe and opens no probe driver without the flag', async () => {
    const probes = fakeProbeDriver();
    const result = await run(['--name', 'alpha'], env(), READ_ONLY, { openProbeDriver: probes.factory });
    expect(result.err).toBe('');
    expect(result.out).not.toContain('Write probe');
    expect(probes.settings).toEqual([]);
  });

  it('prints that the login can write, with outcome warn and the write probe as the check, when the statement is accepted', async () => {
    const result = await probeRun(['--name', 'alpha', '--write-probe']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Outcome: warn\nState: degraded\nReason: The login can write to the source; give Neburyx a login that can only read.\n');
    expect(result.out).toContain('Read-only: write probe\nLogin can write: yes\nMapping checks: pass\nChecked at: 2026-11-02T10:00:00.000Z\nWrite probe: login can write\n');
    expect(result.store.checks[0]?.report).toMatchObject({ readOnlyCheck: 'write-probe', loginCanWrite: true, outcome: 'warn' });
  });

  it('prints that the server refused to create a node, and that the login cannot write, when the privileges showed no write right', async () => {
    const result = await probeRun(['--name', 'alpha', '--write-probe'], { runError: neo4jError('Neo.ClientError.Security.Forbidden') });
    expect(result.out).toContain('Outcome: pass\nState: connected\n');
    expect(result.out).toContain('Read-only: write probe\nLogin can write: no\nMapping checks: pass\nChecked at: 2026-11-02T10:00:00.000Z\nWrite probe: the server refused to create a node\n');
    expect(result.store.checks[0]?.report).toMatchObject({ readOnlyCheck: 'write-probe', loginCanWrite: false });
  });

  it('keeps a write right that the privileges show when the server refuses to create a node, since that refusal does not show that the login cannot write', async () => {
    const result = await probeRun(['--name', 'alpha', '--write-probe'], { runError: neo4jError('Neo.ClientError.Security.Forbidden') }, { rows: [SERVER_ROW], privileges: [{ access: 'GRANTED', action: 'set_property', resource: 'property(note)', graph: '*', segment: 'NODE(*)' }] });
    expect(result.out).toContain('Outcome: warn\nState: degraded\nReason: The login can write to the source; give Neburyx a login that can only read.\n');
    expect(result.out).toContain('Read-only: privileges inspected\nLogin can write: yes\nMapping checks: pass\nChecked at: 2026-11-02T10:00:00.000Z\nWrite probe: the server refused to create a node\n');
    expect(result.store.checks[0]?.report).toMatchObject({ readOnlyCheck: 'privileges-inspected', loginCanWrite: true, outcome: 'warn' });
  });

  it.each([
    ['a Community server that refuses the privileges', { rows: [SERVER_ROW] }, 'Read-only: not verified\nLogin can write: unknown\nMapping checks: pass', null, 'not-verified'],
    ['a listing of a login that only reads', READ_ONLY, 'Read-only: privileges inspected\nLogin can write: no\nMapping checks: pass', false, 'privileges-inspected'],
  ] as const)('keeps the result of the privileges for %s when the probe is inconclusive, and prints that it could not be completed', async (_name, behaviour, lines, canWrite, check) => {
    const result = await probeRun(['--name', 'alpha', '--write-probe'], { runError: neo4jError('Neo.TransientError.General.DatabaseUnavailable') }, behaviour);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`${lines}\nChecked at: 2026-11-02T10:00:00.000Z\nWrite probe: could not be completed\n`);
    expect(result.store.checks[0]?.report).toMatchObject({ readOnlyCheck: check, loginCanWrite: canWrite });
  });

  it('does not run the probe, and says so, for a source that did not answer', async () => {
    const probes = fakeProbeDriver();
    const result = await run(['--name', 'alpha', '--write-probe'], env(), { beginError: neo4jError('ServiceUnavailable') }, { openProbeDriver: probes.factory });
    expect(result.code).toBe(1);
    expect(result.out).toContain('Outcome: fail');
    expect(result.out.endsWith('Write probe: not run, the source did not answer\n')).toBe(true);
    expect(result.err).toBe('');
    expect(probes.settings).toEqual([]);
  });

  it('does not run the probe, and says so, for a server version outside the support matrix', async () => {
    const probes = fakeProbeDriver();
    const result = await run(['--name', 'alpha', '--write-probe'], env(), { rows: [{ ...SERVER_ROW, version: '4.4.0' }], privileges: [] }, { openProbeDriver: probes.factory });
    expect(result.code).toBe(0);
    expect(result.out.endsWith('Write probe: not run, the server version is not on the support matrix\n')).toBe(true);
    expect(result.err).toBe('');
    expect(probes.settings).toEqual([]);
  });

  it('writes the line of a rollback that failed to stderr, as the fields only, after the notice', async () => {
    const result = await probeRun(['--name', 'alpha', '--write-probe'], { rollbackError: neo4jError('ServiceUnavailable', 'MARKER_MESSAGE') });
    expect(result.code).toBe(0);
    expect(result.err).toBe('write probe: opening a write transaction on source alpha and rolling it back\n{"event":"source.write_probe_rollback_failed","sourceId":"alpha"}\n');
    expect(result.out).toContain('Write probe: login can write\n');
  });

  it('prints nothing of the credentials, the address or the driver message', async () => {
    const result = await probeRun(['--name', 'alpha', '--write-probe'], { runError: neo4jError('Neo.ClientError.Security.Forbidden', 'MARKER_MESSAGE bolt://MARKER_HOST') });
    expect(result.out + result.err).not.toContain('MARKER');
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
    ['42703', undefined, 'the database schema is behind this version; run neburyx migrate\n'],
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
