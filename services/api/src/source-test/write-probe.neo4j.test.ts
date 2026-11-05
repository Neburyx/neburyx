import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { ALWAYS_USABLE } from '../testing/usability.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import neo4j from 'neo4j-driver';
import type { Login } from '@neburyx/test-neo4j';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryAppStore } from '../testing/app-store.js';
import { sourceWith } from '../testing/gate-fixtures.js';
import { fileOf } from '../testing/mapping.js';
import { seedFixtureGraph } from '../testing/seed-graph.js';
import { createSourceGate } from '../gate/source-gate.js';
import { communitySeams } from '../seams/community-seams.js';
import { mappingOf } from '../testing/gate-fixtures.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { createReachabilityCache } from '../source-ping/cache.js';
import { createScheduledPing } from '../source-ping/ping.js';
import { runWriteProbe } from '../sources/write-probe.js';
import { createStartupChecker } from './startup.js';
import { createSourceTester } from './tester.js';
import { envFor, NEO4J_ENV_PASSWORD, NEO4J_ENV_USER, runAdmin, runAll, sourceFor, startNeo4j, transactionIsListed, waitUntilNotListed, type RunningNeo4j } from '../testing/neo4j-server.js';
import { runTestSourceCommand } from './command.js';

const folder = mkdtempSync(join(tmpdir(), 'write-probe-neo4j-'));
let normal: RunningNeo4j;
/** A database of its own that has been made read-only: `ALTER DATABASE ... SET ACCESS READ ONLY`. */
let readOnly: RunningNeo4j;
/** Logins of this run, made for the test: one that can only read the database and one that can write and create names there. */
let reader: Login;
let writer: Login;

const mappingFor = (server: RunningNeo4j, name: string): string => {
  const file = join(folder, `${name}.yaml`);
  writeFileSync(file, fileOf(sourceWith('alpha', { uri: server.boltUri, database: server.database, auth: { kind: 'basic', username_env: NEO4J_ENV_USER, password_env: NEO4J_ENV_PASSWORD } })));
  return file;
};

beforeAll(async () => {
  [normal, readOnly] = await Promise.all([startNeo4j(), startNeo4j()]);
  reader = normal.reader;
  writer = await normal.createLogin('writer');
  // a small synthetic graph, with a label, a relationship type and a property key, so that a leftover of the probe would show against it
  await seedFixtureGraph(normal);
  await runAdmin(normal, 'CREATE (:Item {n: 1})-[:NEXT {w: 1}]->(:Item {n: 2})');
  await seedFixtureGraph(readOnly);
});

afterAll(async () => {
  await runAll([() => normal?.stop(), () => readOnly?.stop()]);
  rmSync(folder, { recursive: true, force: true });
});

async function command(server: RunningNeo4j, args: readonly string[], login: Login) {
  let out = '';
  let err = '';
  const store = memoryAppStore();
  const code = await runTestSourceCommand(args, { DATABASE_URL: 'postgres://unused.example.test/unused', NEBURYX_CONFIG: mappingFor(server, args.join('-').replace(/[^a-z-]/g, '')), ...envFor(server, login) }, {
    stdout: { write: (text) => (out += text) },
    stderr: { write: (text) => (err += text) },
    openStore: () => store,
  });
  return { code, out, err, store };
}

/** What a source holds: the counts, the tokens, and the transactions the server still lists, read through the admin driver of the container. */
async function snapshot(server: RunningNeo4j) {
  const session = server.admin.session({ database: server.database });
  try {
    const count = async (cypher: string): Promise<number> => neo4j.integer.toNumber((await session.run(cypher)).records[0]?.get('found'));
    const names = async (cypher: string): Promise<string[]> => (await session.run(cypher)).records.map((record) => String(record.get('name'))).sort();
    return {
      nodes: await count('MATCH (n) RETURN count(n) AS found'),
      relationships: await count('MATCH ()-[r]->() RETURN count(r) AS found'),
      labels: await names('CALL db.labels() YIELD label AS name RETURN name'),
      relationshipTypes: await names('CALL db.relationshipTypes() YIELD relationshipType AS name RETURN name'),
      propertyKeys: await names('CALL db.propertyKeys() YIELD propertyKey AS name RETURN name'),
    };
  } finally {
    await session.close();
  }
}

describe(`neburyx test-source --write-probe against the dev Neo4j server`, () => {
  it('reports write-probe, a login that can write and outcome warn on a server that accepts the statement, and says so on stderr', async () => {
    const result = await command(normal, ['--name', 'alpha', '--write-probe'], writer);
    expect(result.code).toBe(0);
    expect(result.err).toBe('write probe: opening a write transaction on source alpha and rolling it back\n');
    expect(result.out).toContain('Outcome: warn\nState: degraded\nReason: The login can write to the source; give Neburyx a login that can only read.\n');
    expect(result.out).toContain('Read-only: write probe\nLogin can write: yes\n');
    expect(result.out.endsWith('Write probe: login can write\n')).toBe(true);
    expect(result.store.checks[0]?.report).toMatchObject({ readOnlyCheck: 'write-probe', loginCanWrite: true, outcome: 'warn' });
  });

  it('reports a login that can only read as unable to write, with the server refusing the probe, and writes nothing', async () => {
    const before = await snapshot(normal);
    const answer = await runWriteProbe(sourceFor(normal), 'tr-probe-reader', { env: envFor(normal, reader), logger: { warn: () => undefined } });
    expect(answer).toBe('cannot-write');
    const result = await command(normal, ['--name', 'alpha', '--write-probe'], reader);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Login can write: no\n');
    expect(result.out.endsWith('Write probe: the server refused to create a node\n')).toBe(true);
    expect(await snapshot(normal)).toEqual(before);
  });

  it('is refused by the server for a database that has been made read-only, even for a login that can write, and was not refused before', async () => {
    const login = await readOnly.createLogin('writer');
    const probe = (traceId: string) => runWriteProbe(sourceFor(readOnly), traceId, { env: envFor(readOnly, login), logger: { warn: () => undefined } });
    expect(await probe('tr-probe-before-read-only')).toBe('can-write');
    await readOnly.setReadOnly();
    expect(await probe('tr-probe-read-only')).toBe('cannot-write');
  });
});

describe(`a test run leaves the source as it was, on the dev Neo4j server`, () => {
  it.each([
    ['a run without the probe', ['--name', 'alpha']],
    ['a run with the probe', ['--name', 'alpha', '--write-probe']],
  ])('%s changes no count, no label, no relationship type and no property key', async (_name, args) => {
    const before = await snapshot(normal);
    expect(before.labels).toContain('Item');
    expect(before.relationshipTypes).toContain('NEXT');
    const result = await command(normal, args, writer);
    expect(result.code).toBe(0);
    expect(await snapshot(normal)).toEqual(before);
  });

  it('changes nothing after the probe runs five times in a row', async () => {
    const before = await snapshot(normal);
    for (let run = 0; run < 5; run += 1) expect((await command(normal, ['--name', 'alpha', '--write-probe'], writer)).code).toBe(0);
    expect(await snapshot(normal)).toEqual(before);
  });

  it.each([
    ['a login that can only read', 'reader', 'pass'],
    ['a login that can write', 'writer', 'warn'],
  ] as const)('changes nothing for the route, the startup check and several pings, which are the other ways a source is read, with %s', async (_name, who, outcome) => {
    const login = who === 'reader' ? reader : writer;
    const before = await snapshot(normal);
    const mapping = mappingOf(sourceWith('alpha', { uri: normal.boltUri, database: normal.database, auth: { kind: 'basic', username_env: NEO4J_ENV_USER, password_env: NEO4J_ENV_PASSWORD } }));
    const parts = createSourceGate({ usability: ALWAYS_USABLE, mapping, env: envFor(normal, login), seams: communitySeams(), logger: { warn: () => undefined } });
    try {
      const store = memoryAppStore();
      const logger = { info: () => undefined, warn: () => undefined };
      const tester = createSourceTester({ gate: parts.gate, mapping, store });
      expect((await tester.run({ traceId: 'tr-route', principal: LOCAL_PRINCIPAL, sourceId: 'alpha' })).outcome).toBe(outcome);
      const started = await createStartupChecker({ system: parts.system, mapping, store, logger }).run();
      expect(started).toEqual([expect.objectContaining({ sourceId: 'alpha', outcome, answered: true })]);
      const ping = createScheduledPing({ system: parts.system, mapping, cache: createReachabilityCache(['alpha']) });
      for (let tick = 0; tick < 3; tick += 1) expect((await ping.run())[0]?.current).toBe('reachable');
    } finally {
      await parts.close();
    }
    expect(await snapshot(normal)).toEqual(before);
  });

  it('leaves no transaction of the probe open: a transaction with the same metadata is found while it is open, and the probe leaves none', async () => {
    const control = normal.admin.session({ database: normal.database });
    const open = await control.beginTransaction({ metadata: { traceId: 'tr-control' } });
    try {
      await open.run('RETURN 1');
      expect(await transactionIsListed(normal, 'tr-control')).toBe(true);
    } finally {
      await open.rollback();
      await control.close();
    }
    expect(await waitUntilNotListed(normal, 'tr-control', 30_000)).toBe(true);

    const before = await snapshot(normal);
    const answer = await runWriteProbe(sourceFor(normal), 'tr-probe-after', { env: envFor(normal, writer), logger: { warn: () => undefined } });
    expect(answer).toBe('can-write');
    expect(await waitUntilNotListed(normal, 'tr-probe-after', 30_000)).toBe(true);
    expect(await snapshot(normal)).toEqual(before);
  });

  it('leaves no transaction of the command open either', async () => {
    expect((await command(normal, ['--name', 'alpha', '--write-probe'], writer)).code).toBe(0);
    const session = normal.admin.session({ database: 'system' });
    try {
      const listed = await session.run("SHOW TRANSACTIONS YIELD metaData, database WHERE metaData.traceId STARTS WITH 'tr-cli-' AND database = $database RETURN count(*) AS listed", { database: normal.database });
      expect(neo4j.integer.toNumber(listed.records[0]?.get('listed'))).toBe(0);
    } finally {
      await session.close();
    }
  });
});
