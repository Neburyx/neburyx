import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sourceTestReportSchema } from '@neburyx/contracts';
import { buildApp } from '../app.js';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { envFor, NEO4J_ENV_PASSWORD, NEO4J_ENV_USER, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { seedFixtureGraph } from '../testing/seed-graph.js';
import { makeWebRoot } from '../testing/web-root.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { createSourceTester } from './tester.js';

const webRoot = makeWebRoot();
let server: RunningNeo4j;
let sourceGate: SourceGate;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  server = await startNeo4j();
  await seedFixtureGraph(server);
  const mapping = mappingOf(
    sourceWith('alpha', { uri: server.boltUri, database: server.database, auth: { kind: 'basic', username_env: NEO4J_ENV_USER, password_env: NEO4J_ENV_PASSWORD } }),
  );
  sourceGate = createSourceGate({ mapping, env: envFor(server), seams: communitySeams(), logger: { warn: () => undefined } });
  app = await buildApp({
    webRoot,
    logger: pino({ level: 'silent' }),
    store: memoryAppStore(),
    mapping,
    sourceTester: createSourceTester({ gate: sourceGate.gate, mapping, store: memoryAppStore() }),
    closeSources: () => sourceGate.close(),
  });
});

afterAll(async () => {
  await runAll([() => app?.close(), () => server?.stop()]);
  rmSync(webRoot, { recursive: true, force: true });
});

describe(`POST /v1/sources/{id}/test against the dev Neo4j server`, () => {
  it('reports pass with the version of the server and the operations the adapter declares', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/sources/alpha/test' });
    expect(response.statusCode).toBe(200);
    const report = sourceTestReportSchema.parse(response.json());
    const tag = server.image.split(':')[1] ?? '';
    expect(report).toMatchObject({ sourceId: 'alpha', outcome: 'pass', state: 'connected', stateReason: null, versionSupported: true, readOnlyCheck: 'privileges-inspected', loginCanWrite: false });
    expect(report.server?.product).toBe('Neo4j Kernel');
    expect(report.server?.version === tag || report.server?.version.startsWith(`${tag}.`)).toBe(true);
    expect(report.operations.length).toBeGreaterThan(0);
  });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return typeof address === 'object' && address !== null ? address.port : 0;
}

describe(`a source that fails, on the dev Neo4j server`, () => {
  async function reportWith(overrides: Record<string, unknown>, env: Record<string, string | undefined>) {
    const mapping = mappingOf(
      sourceWith('beta', { uri: server.boltUri, database: server.database, auth: { kind: 'basic', username_env: NEO4J_ENV_USER, password_env: NEO4J_ENV_PASSWORD }, ...overrides }),
    );
    const parts = createSourceGate({ mapping, env, seams: communitySeams(), logger: { warn: () => undefined } });
    try {
      return await createSourceTester({ gate: parts.gate, mapping, store: memoryAppStore() }).run({ traceId: 'tr-failure', principal: LOCAL_PRINCIPAL, sourceId: 'beta' });
    } finally {
      await parts.close();
    }
  }

  it('reports authentication for a wrong password', async () => {
    const report = await reportWith({}, { ...envFor(server), [NEO4J_ENV_PASSWORD]: 'not-the-password' });
    expect(report).toMatchObject({ outcome: 'fail', state: 'unavailable', stateReason: 'The source refused the sign-in.' });
  });

  it('reports unreachable for a closed port', async () => {
    const report = await reportWith({ uri: `bolt://127.0.0.1:${await freePort()}` }, envFor(server));
    expect(report).toMatchObject({ outcome: 'fail', state: 'unavailable', stateReason: 'The source could not be reached.' });
  });

  it('reports database for a database name the server does not have', async () => {
    const report = await reportWith({ database: 'nodatabase' }, envFor(server, server));
    expect(report).toMatchObject({ outcome: 'fail', state: 'unavailable', stateReason: 'The database named in the mapping does not exist on the server.' });
  });

  it('reports credentials for unset credential variables', async () => {
    const report = await reportWith({}, {});
    expect(report).toMatchObject({ outcome: 'fail', state: 'unavailable', stateReason: 'The credentials named in the mapping are not set.' });
  });
});
