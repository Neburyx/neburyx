import { describe, expect, it } from 'vitest';
import { sourceTestReportSchema } from '@neburyx/contracts';
import { assembleGate } from '../gate/assemble.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { type FakeBehaviour, fakeDrivers, neo4jError } from '../testing/fake-source-driver.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { SERVER_ROW } from '../testing/source-tester.js';
import { createSourceTester } from './tester.js';

const ENV = { MARKER_USER_VAR: 'MARKER_USER_VALUE', MARKER_PASS_VAR: 'MARKER_PASS_VALUE' };
const AUTH = { kind: 'basic', username_env: 'MARKER_USER_VAR', password_env: 'MARKER_PASS_VAR' };
const request = { traceId: 'tr-test', principal: LOCAL_PRINCIPAL, sourceId: 'alpha' };
const WRITE_SENTENCE = 'The login can write to the source; give Neburyx a login that can only read.';
const UNSUPPORTED_ADMIN = 'Neo.ClientError.Statement.UnsupportedAdministrationCommand';

const row = (action: string, overrides: Record<string, string> = {}) => ({ access: 'GRANTED', action, resource: 'graph', graph: '*', segment: 'NODE(*)', ...overrides });

interface LoggedLine {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function rig(behaviour: FakeBehaviour, options: { readonly maxPage?: number; readonly seams?: Partial<Seams>; readonly redact?: Parameters<typeof assembleGate>[0]['redact'] } = {}) {
  const mapping = mappingOf(sourceWith('alpha', { uri: 'neo4j+s://MARKER_HOST.example.test:7687', auth: AUTH, ...(options.maxPage === undefined ? {} : { budgets: { max_page: options.maxPage } }) }));
  const fake = fakeDrivers({ rows: [SERVER_ROW], ...behaviour });
  const logs: LoggedLine[] = [];
  const logger = { warn: (fields: object, message: string) => void logs.push({ fields: { ...fields }, message }) };
  const executor = createNeo4jExecutor({ sources: mapping.sources, env: ENV, logger, createDriver: fake.factory });
  const defaults = communitySeams();
  const parts = assembleGate({ mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit, ...options.seams }, executor, logger, ...(options.redact === undefined ? {} : { redact: options.redact }) });
  const store = memoryAppStore();
  const tester = createSourceTester({ gate: parts.gate, mapping, store, logger, clock: () => Date.UTC(2026, 10, 2, 10, 0, 0) });
  return { tester, fake, logs, executor, store, gate: parts.gate };
}

const privilegeQueries = (fake: ReturnType<typeof fakeDrivers>) =>
  fake.drivers.flatMap((driver) => driver.sessions.flatMap((session) => session.queries)).filter((query) => query.cypher.startsWith('SHOW USER PRIVILEGES'));

describe('a server that cannot list the privileges', () => {
  it.each([
    ['a Community server', neo4jError(UNSUPPORTED_ADMIN, 'MARKER_MESSAGE')],
    ['a statement that belongs to the system database', neo4jError('Neo.ClientError.Statement.NotSystemDatabaseError', 'MARKER_MESSAGE')],
  ])('%s is reported pass with read-only not verified, and the executor writes one read_failed line with the server code', async (_name, error) => {
    const { tester, logs, store } = rig({ privilegesError: error });
    const report = sourceTestReportSchema.parse(await tester.run(request));
    expect(report).toMatchObject({ outcome: 'pass', state: 'connected', stateReason: null, versionSupported: true, readOnlyCheck: 'not-verified', loginCanWrite: null });
    expect(store.checks).toHaveLength(1);
    const lines = logs.filter((line) => line.fields['event'] === 'source.read_failed');
    expect(lines).toEqual([{ fields: { event: 'source.read_failed', sourceId: 'alpha', serverCode: (error as { code: string }).code }, message: 'source read failed' }]);
    expect(JSON.stringify([report, logs])).not.toContain('MARKER_MESSAGE');
  });

  it.each([
    ['a refusal by the login', neo4jError('Neo.ClientError.Security.Forbidden', 'MARKER_MESSAGE')],
    ['a timeout', neo4jError('Neo.ClientError.Transaction.TransactionTimedOut', 'MARKER_MESSAGE')],
    ['a lost connection', neo4jError('ServiceUnavailable', 'MARKER_MESSAGE')],
    ['a sign-in the server then refuses', neo4jError('Neo.ClientError.Security.Unauthorized', 'MARKER_MESSAGE')],
    ['an error the executor does not know', neo4jError('Neo.ClientError.Statement.SyntaxError', 'MARKER_MESSAGE')],
  ])('%s when the second read starts is reported with read-only not verified and the rest of the report as the capabilities read made it', async (_name, error) => {
    const { tester, store } = rig({ laterBeginError: error });
    const report = sourceTestReportSchema.parse(await tester.run(request));
    expect(report).toMatchObject({ outcome: 'pass', state: 'connected', server: { product: 'Neo4j Kernel', version: '5.26.32' }, versionSupported: true, readOnlyCheck: 'not-verified', loginCanWrite: null });
    expect(store.checks).toHaveLength(1);
  });

  it('is reported not verified when the stream of the privileges read fails with an error the executor does not know', async () => {
    const { tester } = rig({ privilegesError: neo4jError('Neo.DatabaseError.General.UnknownError', 'MARKER_MESSAGE') });
    expect(await tester.run(request)).toMatchObject({ outcome: 'pass', readOnlyCheck: 'not-verified', loginCanWrite: null });
  });

  it('is reported not verified when the page holds more rows than the limit', async () => {
    const { tester } = rig({ privileges: Array.from({ length: 6 }, () => row('write')) }, { maxPage: 5 });
    expect(await tester.run(request)).toMatchObject({ outcome: 'pass', readOnlyCheck: 'not-verified', loginCanWrite: null });
  });

  it('asks for as many rows as the source allows in a page, and for no more than that', async () => {
    const { tester, fake } = rig({ privileges: [] }, { maxPage: 5 });
    await tester.run(request);
    const [query, ...others] = privilegeQueries(fake);
    expect(others).toEqual([]);
    expect(Object.keys(query?.parameters ?? {})).toEqual(['limit']);
    // the adapter sends integers as the driver's Integer type
    expect(String(query?.parameters['limit'])).toBe('5');
  });
});

describe('a failure of the privileges read that says nothing about the source', () => {
  it.each([
    ['a full pool', () => rig({ laterBeginError: neo4jError('N/A', 'Connection acquisition timed out in 2000 ms.') }), 'SOURCE_UNAVAILABLE'],
    [
      'a source that turns busy',
      () => {
        let granted = 0;
        const defaults = communitySeams();
        const coordinator = { acquireRead: (call: Parameters<typeof defaults.coordinator.acquireRead>[0]) => (granted++ === 0 ? defaults.coordinator.acquireRead(call) : Promise.resolve({ status: 'busy' as const })) };
        return rig({ privileges: [] }, { seams: { coordinator } });
      },
      'SOURCE_BUSY',
    ],
    ['a failure of the redact stage', () => rig({ privileges: [] }, { redact: () => { throw new Error('MARKER_MESSAGE'); } }), 'INTERNAL_ERROR'],
  ])('%s is rethrown and stores nothing', async (_name, make, code) => {
    const { tester, store } = make();
    await expect(tester.run(request)).rejects.toMatchObject({ code });
    expect(store.checks).toEqual([]);
  });

  it('is rethrown for an executor that closes between the two reads, and stores nothing', async () => {
    let executor: { close(): Promise<void> } | undefined;
    let granted = 0;
    const defaults = communitySeams();
    const coordinator = {
      acquireRead: async (call: Parameters<typeof defaults.coordinator.acquireRead>[0]) => {
        if (granted++ === 1) await executor?.close();
        return defaults.coordinator.acquireRead(call);
      },
    };
    const parts = rig({ privileges: [] }, { seams: { coordinator } });
    executor = parts.executor;
    await expect(parts.tester.run(request)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(parts.store.checks).toEqual([]);
  });

  it('tells a failure of the redact stage from a failed read: the first has no reason, the second is tagged read-failed', async () => {
    const redacted = await rig({ privileges: [] }, { redact: () => { throw new Error('MARKER_MESSAGE'); } })
      .gate.run({ ...request, templateId: 'privileges', params: {}, limit: 5 })
      .catch((caught: unknown) => caught);
    expect(redacted).toMatchObject({ code: 'INTERNAL_ERROR', reason: undefined });
    const failed = await rig({ beginError: neo4jError('Neo.ClientError.Statement.SyntaxError', 'MARKER_MESSAGE') })
      .gate.run({ ...request, templateId: 'privileges', params: {}, limit: 5 })
      .catch((caught: unknown) => caught);
    expect(failed).toMatchObject({ code: 'INTERNAL_ERROR', reason: 'read-failed' });
  });
});

describe('a server that lists privileges the check cannot read', () => {
  const UNREADABLE = 'The server listed privileges that could not be read, so read-only is not verified.';
  const odd = [{ access: 'GRANTED', action: 7, resource: 'MARKER_VALUE', graph: '*', segment: 'NODE(*)' }, { unexpected: 'MARKER_VALUE' }];

  it('is reported warn and degraded with the fixed sentence, read-only not verified, and the capabilities as read', async () => {
    const { tester, store } = rig({ privileges: odd });
    const report = sourceTestReportSchema.parse(await tester.run(request));
    expect(report).toMatchObject({ outcome: 'warn', state: 'degraded', stateReason: UNREADABLE, versionSupported: true, server: { version: '5.26.32' }, readOnlyCheck: 'not-verified', loginCanWrite: null });
    expect(store.checks).toHaveLength(1);
  });

  it('writes one line with the number of rows and the type of each column, and no value', async () => {
    const { tester, logs } = rig({ privileges: odd });
    await tester.run(request);
    const lines = logs.filter((line) => line.fields['event'] === 'source.privileges_unreadable');
    expect(lines).toEqual([
      {
        fields: { event: 'source.privileges_unreadable', sourceId: 'alpha', rows: 2, columnTypes: [{ access: 'string', action: 'number', resource: 'string', graph: 'string', segment: 'string' }, { unexpected: 'string' }] },
        message: 'source privileges could not be read',
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain('MARKER_VALUE');
  });

  it('says the version sentence only on a server outside the matrix', async () => {
    const { tester } = rig({ rows: [{ ...SERVER_ROW, version: '4.4.0' }], privileges: odd });
    expect(await tester.run(request)).toMatchObject({ outcome: 'warn', stateReason: 'The server version is not on the support matrix.', readOnlyCheck: 'not-verified' });
  });

  it('leaves a listing that can be read alone: no line is written', async () => {
    const { tester, logs } = rig({ privileges: [] });
    await tester.run(request);
    expect(logs.filter((line) => line.fields['event'] === 'source.privileges_unreadable')).toEqual([]);
  });
});

describe('a source that did not answer the capabilities read', () => {
  it('is reported fail and the privileges are not inspected', async () => {
    const { tester, fake } = rig({ beginError: neo4jError('ServiceUnavailable', 'MARKER_MESSAGE') });
    expect(await tester.run(request)).toMatchObject({ outcome: 'fail', readOnlyCheck: 'not-verified', loginCanWrite: null });
    expect(privilegeQueries(fake)).toEqual([]);
    expect(fake.begins).toBe(1);
  });
});

describe('a server that lists the privileges', () => {
  it('reports a login with no right beyond reading as inspected, and not able to write', async () => {
    const { tester } = rig({ privileges: [] });
    expect(sourceTestReportSchema.parse(await tester.run(request))).toMatchObject({ outcome: 'pass', state: 'connected', stateReason: null, readOnlyCheck: 'privileges-inspected', loginCanWrite: false });
  });

  it('reports a login that can write as warn, degraded, with the fixed sentence', async () => {
    const { tester } = rig({ privileges: [row('write')] });
    expect(sourceTestReportSchema.parse(await tester.run(request))).toMatchObject({
      outcome: 'warn',
      state: 'degraded',
      stateReason: WRITE_SENTENCE,
      versionSupported: true,
      readOnlyCheck: 'privileges-inspected',
      loginCanWrite: true,
    });
  });

  it('reports a listing the verdict cannot settle as not verified, with the outcome of the capabilities read', async () => {
    const { tester } = rig({ privileges: [row('an_action_of_a_newer_server')] });
    expect(await tester.run(request)).toMatchObject({ outcome: 'pass', readOnlyCheck: 'not-verified', loginCanWrite: null });
  });

  it('says only the write sentence when the version is also outside the matrix, and versionSupported still says why the other warning exists', async () => {
    const { tester } = rig({ rows: [{ ...SERVER_ROW, version: '4.4.0' }], privileges: [row('write')] });
    expect(await tester.run(request)).toMatchObject({ outcome: 'warn', state: 'degraded', stateReason: WRITE_SENTENCE, versionSupported: false, loginCanWrite: true });
  });

  it('reports the version warning for a read-only login on an unsupported server', async () => {
    const { tester } = rig({ rows: [{ ...SERVER_ROW, version: '4.4.0' }], privileges: [] });
    expect(await tester.run(request)).toMatchObject({ outcome: 'warn', stateReason: 'The server version is not on the support matrix.', readOnlyCheck: 'privileges-inspected', loginCanWrite: false });
  });

  it('reads the privileges in a read transaction on the source database, as the caller', async () => {
    const { tester, fake } = rig({ privileges: [] });
    await tester.run(request);
    const sessions = fake.drivers.flatMap((driver) => driver.sessions);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.config.defaultAccessMode)).toEqual(['READ', 'READ']);
    expect(fake.forbidden).toEqual([]);
  });
});
