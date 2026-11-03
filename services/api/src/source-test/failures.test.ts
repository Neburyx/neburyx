import { rmSync } from 'node:fs';
import { ALWAYS_USABLE } from '../testing/usability.js';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { sourceTestReportSchema } from '@neburyx/contracts';
import { buildApp } from '../app.js';
import { assembleGate } from '../gate/assemble.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { type FakeBehaviour, fakeDrivers, neo4jError } from '../testing/fake-source-driver.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { SERVER_ROW } from '../testing/source-tester.js';
import { makeWebRoot } from '../testing/web-root.js';
import { createSourceTester } from './tester.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const ENV = { MARKER_USER_VAR: 'MARKER_USER_VALUE', MARKER_PASS_VAR: 'MARKER_PASS_VALUE' };
const mapping = mappingOf(
  sourceWith('alpha', { uri: 'neo4j+s://MARKER_HOST.example.test:7687', auth: { kind: 'basic', username_env: 'MARKER_USER_VAR', password_env: 'MARKER_PASS_VAR' } }),
);
const request = { traceId: 'tr-test', principal: LOCAL_PRINCIPAL, sourceId: 'alpha' };

interface LoggedLine {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function rig(behaviour: FakeBehaviour, env: Record<string, string | undefined> = ENV, seams: Partial<Seams> = {}) {
  const fake = fakeDrivers(behaviour);
  const logs: LoggedLine[] = [];
  const logger = { warn: (fields: object, message: string) => void logs.push({ fields: { ...fields }, message }) };
  const executor = createNeo4jExecutor({ sources: mapping.sources, env, logger, createDriver: fake.factory });
  const defaults = communitySeams();
  const parts = assembleGate({ usability: ALWAYS_USABLE, mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit, ...seams }, executor, logger });
  const tester = createSourceTester({ gate: parts.gate, mapping, store: memoryAppStore(), clock: () => Date.UTC(2026, 10, 2, 10, 0, 0) });
  return { tester, fake, logs, executor, gate: parts.gate };
}

const message = 'MARKER_MESSAGE: bolt://MARKER_HOST.example.test:7687 MATCH (n) RETURN n';

const VERDICTS: readonly (readonly [string, FakeBehaviour, Record<string, string | undefined>, string])[] = [
  ['unreachable', { beginError: neo4jError('ServiceUnavailable', message) }, ENV, 'The source could not be reached.'],
  ['unreachable (a lost session)', { beginError: neo4jError('SessionExpired', message) }, ENV, 'The source could not be reached.'],
  ['authentication', { beginError: neo4jError('Neo.ClientError.Security.Unauthorized', message) }, ENV, 'The source refused the sign-in.'],
  ['credentials', { rows: [SERVER_ROW] }, {}, 'The credentials named in the mapping are not set.'],
  ['database', { beginError: neo4jError('Neo.ClientError.Database.DatabaseNotFound', message) }, ENV, 'The database named in the mapping does not exist on the server.'],
  ['refused (forbidden)', { beginError: neo4jError('Neo.ClientError.Security.Forbidden', message) }, ENV, 'The source refused the read.'],
  ['refused (a procedure error)', { beginError: neo4jError('Neo.ClientError.Procedure.ProcedureNotFound', message) }, ENV, 'The source refused the read.'],
  ['timeout', { beginError: neo4jError('Neo.ClientError.Transaction.TransactionTimedOut', message) }, ENV, 'The source did not answer in time.'],
];

describe.each(VERDICTS)('a source that fails as %s', (_name, behaviour, env, sentence) => {
  it('is reported fail, unavailable, with nothing known about the server and a fixed sentence', async () => {
    const { tester } = rig(behaviour, env);
    const report = sourceTestReportSchema.parse(await tester.run(request));
    expect(report).toMatchObject({
      outcome: 'fail',
      state: 'unavailable',
      stateReason: sentence,
      server: null,
      versionSupported: null,
      operations: [],
      readOnlyCheck: 'not-verified',
    });
  });

  it('puts no address, variable name, secret, server message or query in the report or the log lines', async () => {
    const { tester, logs } = rig(behaviour, env);
    const report = await tester.run(request);
    expect(JSON.stringify([report, logs])).not.toContain('MARKER');
  });
});

describe('a failure that says nothing about the source', () => {
  const NOT_VERDICTS: readonly (readonly [string, () => ReturnType<typeof rig>, string])[] = [
    ['a full pool', () => rig({ beginError: neo4jError('N/A', 'Connection acquisition timed out in 2000 ms. Pool status: Active conn count = 1.') }), 'SOURCE_UNAVAILABLE'],
    ['a closed executor', () => rig({ rows: [SERVER_ROW] }), 'SOURCE_UNAVAILABLE'],
    ['a coordinator that refuses admission', () => rig({ rows: [SERVER_ROW] }, ENV, { coordinator: { acquireRead: () => Promise.resolve({ status: 'unavailable' }) } }), 'SOURCE_UNAVAILABLE'],
    ['a busy coordinator', () => rig({ rows: [SERVER_ROW] }, ENV, { coordinator: { acquireRead: () => Promise.resolve({ status: 'busy' }) } }), 'SOURCE_BUSY'],
    ['a policy that denies the principal', () => rig({ rows: [SERVER_ROW] }, ENV, { policy: { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'denied' }) } }), 'ACCESS_DENIED'],
    ['an unexpected driver error', () => rig({ beginError: neo4jError('Neo.ClientError.Statement.SyntaxError', message) }), 'INTERNAL_ERROR'],
  ];

  it.each(NOT_VERDICTS)('%s is rethrown as %s and no report is returned', async (name, make, code) => {
    const parts = make();
    if (name === 'a closed executor') await parts.executor.close();
    await expect(parts.tester.run(request)).rejects.toMatchObject({ code });
  });

  it('with a denying policy makes no read', async () => {
    const parts = rig({ rows: [SERVER_ROW] }, ENV, { policy: { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'denied' }) } });
    await expect(parts.tester.run(request)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(parts.fake.drivers).toEqual([]);
  });
});

describe('the same tester after a failure', () => {
  it('reports pass once the source answers', async () => {
    const parts = rig({ beginError: neo4jError('ServiceUnavailable', message) });
    expect((await parts.tester.run(request)).outcome).toBe('fail');
    parts.fake.behaviour = { rows: [SERVER_ROW] };
    expect(await parts.tester.run(request)).toMatchObject({ outcome: 'pass', state: 'connected', stateReason: null });
  });
});

describe('the gate answer for a read that the server refuses', () => {
  it.each([
    ['database', neo4jError('Neo.ClientError.Database.DatabaseNotFound', message), 'Neo.ClientError.Database.DatabaseNotFound'],
    ['refused', neo4jError('Neo.ClientError.Security.Forbidden', message), 'Neo.ClientError.Security.Forbidden'],
  ])('%s carries the tag on the error, and the executor writes one read_failed line with the server code', async (reason, error, serverCode) => {
    const { gate, logs } = rig({ beginError: error });
    const failure: unknown = await gate.run({ ...request, templateId: 'capabilities', params: {}, limit: 1 }).catch((caught: unknown) => caught);
    expect(failure).toMatchObject({ code: 'SOURCE_UNAVAILABLE', reason });
    expect(logs.filter((line) => line.fields['event'] === 'source.read_failed')).toEqual([
      { fields: { event: 'source.read_failed', sourceId: 'alpha', serverCode }, message: 'source read failed' },
    ]);
  });

  it.each(['ServiceUnavailable', 'Neo.ClientError.Security.Unauthorized', 'Neo.ClientError.Transaction.TransactionTimedOut'])('%s writes no read_failed line', async (code) => {
    const { gate, logs } = rig({ beginError: neo4jError(code, message) });
    await gate.run({ ...request, templateId: 'capabilities', params: {}, limit: 1 }).catch(() => undefined);
    expect(logs.filter((line) => line.fields['event'] === 'source.read_failed')).toEqual([]);
  });
});

/** A source whose coordinator admits the first reads (capabilities, privileges, the two schema reads) and finds it busy at the next. */
function busyAfter(admitted: number) {
  const defaults = communitySeams();
  let reads = 0;
  return rig({ rows: [SERVER_ROW] }, ENV, { coordinator: { acquireRead: (read) => (++reads > admitted ? Promise.resolve({ status: 'busy' }) : defaults.coordinator.acquireRead(read)) } });
}

describe('POST /v1/sources/{id}/test for each failure', () => {
  async function respond(parts: ReturnType<typeof rig>) {
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), mapping, sourceTester: parts.tester });
    const response = await app.inject({ method: 'POST', url: '/v1/sources/alpha/test' });
    await app.close();
    return response;
  }

  it('answers 200 with a fail report when the source does not answer', async () => {
    const response = await respond(rig({ beginError: neo4jError('ServiceUnavailable', message) }));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'fail', state: 'unavailable', stateReason: 'The source could not be reached.' });
  });

  it.each([
    ['a busy coordinator', () => rig({ rows: [SERVER_ROW] }, ENV, { coordinator: { acquireRead: () => Promise.resolve({ status: 'busy' }) } }), 503, 'SOURCE_BUSY'],
    ['a policy that denies', () => rig({ rows: [SERVER_ROW] }, ENV, { policy: { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'denied' }) } }), 403, 'ACCESS_DENIED'],
    ['an unexpected driver error', () => rig({ beginError: neo4jError('Neo.ClientError.Statement.SyntaxError', message) }), 500, 'INTERNAL_ERROR'],
    ['a full pool', () => rig({ beginError: neo4jError('N/A', 'Connection acquisition timed out in 2000 ms.') }), 503, 'SOURCE_UNAVAILABLE'],
  ])('answers the shared error body for %s', async (_name, make, status, code) => {
    const response = await respond(make());
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(JSON.stringify(response.json())).not.toContain('MARKER');
  });

  it.each([
    ['a timeout of a schema read', { read: 'tokens', error: neo4jError('Neo.ClientError.Transaction.TransactionTimedOut', message) } as const, 504, 'QUERY_TIMEOUT'],
    ['a lost connection during a schema read', { read: 'indexes', error: neo4jError('ServiceUnavailable', message) } as const, 503, 'SOURCE_UNAVAILABLE'],
    ['an error of a schema read the executor does not know', { read: 'indexes', error: neo4jError('Neo.ClientError.Statement.SyntaxError', message) } as const, 500, 'INTERNAL_ERROR'],
  ])('answers the shared error body, not a report, for %s after the capabilities read answered', async (_name, schemaError, status, code) => {
    const response = await respond(rig({ rows: [SERVER_ROW], schemaError }));
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(JSON.stringify(response.json())).not.toContain('MARKER');
  });

  it.each([
    ['a lost connection during a degree probe', () => rig({ rows: [SERVER_ROW], degree: { error: neo4jError('ServiceUnavailable', message) } }), 503, 'SOURCE_UNAVAILABLE'],
    ['an error of a degree probe the executor does not know', () => rig({ rows: [SERVER_ROW], degree: { error: neo4jError('Neo.ClientError.Statement.SyntaxError', message) } }), 500, 'INTERNAL_ERROR'],
    ['a busy source at the first degree probe', () => busyAfter(4), 503, 'SOURCE_BUSY'],
  ])('answers the shared error body, not a report, for %s after the schema reads answered', async (_name, make, status, code) => {
    const response = await respond(make());
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(JSON.stringify(response.json())).not.toContain('MARKER');
  });

  it.each([
    ['database', 'Neo.ClientError.Database.DatabaseNotFound'],
    ['refused', 'Neo.ClientError.Security.Forbidden'],
  ])('answers 503 retryable true with no reason in the body for a read the server refuses (%s) when the gate is called directly', async (reason, code) => {
    const parts = rig({ beginError: neo4jError(code, message) });
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), mapping, sourceTester: parts.tester });
    app.get('/v1/test/read', { config: { permission: 'principal' } }, async () => parts.gate.run({ ...request, templateId: 'capabilities', params: {}, limit: 1 }));
    const response = await app.inject({ method: 'GET', url: '/v1/test/read' });
    await app.close();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'SOURCE_UNAVAILABLE', retryable: true } });
    expect(JSON.stringify(response.json())).not.toContain(reason);
    expect(JSON.stringify(response.json())).not.toContain('MARKER');
  });
});
