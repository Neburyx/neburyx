import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forwardTo } from '@neburyx/test-neo4j';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sourcesResponseSchema } from '@neburyx/contracts';
import { rows, runInProcess } from '../testing/database.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { fileOf } from '../testing/mapping.js';
import { envFor, NEO4J_ENV_PASSWORD, NEO4J_ENV_USER, runAdmin, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { constraintName, createSchema, dropConstraint, dropIndex, seedFixtureGraph } from '../testing/seed-graph.js';
import { firstSource } from '../testing/mapping.js';
import { startApi, stopApi, webRoot } from '../testing/start-api.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const folder = mkdtempSync(join(tmpdir(), 'startup-neo4j-'));
let neo4jServer: RunningNeo4j;
let postgres: TestPostgres;

beforeAll(async () => {
  [neo4jServer, postgres] = await Promise.all([startNeo4j(), startPostgres()]);
  await seedFixtureGraph(neo4jServer);
});

afterAll(async () => {
  await runAll([() => postgres?.stop(), () => neo4jServer?.stop()]);
  rmSync(folder, { recursive: true, force: true });
  rmSync(webRoot, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return typeof address === 'object' && address !== null ? address.port : 0;
}

const auth = { kind: 'basic', username_env: NEO4J_ENV_USER, password_env: NEO4J_ENV_PASSWORD };

async function migrated(): Promise<TestDatabase> {
  const database = await postgres.newDatabase();
  const result = await runInProcess({ DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }, SHIPPED);
  expect(result.code, result.stderr).toBe(0);
  return database;
}

let counter = 0;
function mappingFile(...sources: Record<string, unknown>[]): string {
  counter += 1;
  const file = join(folder, `neburyx-${counter}.yaml`);
  writeFileSync(file, fileOf(...sources));
  return file;
}

describe(`the startup check against the dev Neo4j server`, () => {
  it('leaves a reachable source connected with the version stored and a closed one unavailable, before the first request', async () => {
    const database = await migrated();
    const file = mappingFile(
      sourceWith('alpha', { uri: neo4jServer.boltUri, database: neo4jServer.database, auth }),
      sourceWith('beta', { uri: `bolt://127.0.0.1:${await freePort()}`, database: neo4jServer.database, auth }),
    );
    const { result } = await startApi({ DATABASE_URL: database.appUrl, NEBURYX_CONFIG: file, ...envFor(neo4jServer) });
    if (result.exitCode !== 0) throw new Error('the API did not start');
    try {
      const listed = sourcesResponseSchema.parse((await result.app.inject({ method: 'GET', url: '/v1/sources' })).json());
      expect(listed.items.map((item) => [item.id, item.state, item.stateReason])).toEqual([
        ['alpha', 'connected', null],
        ['beta', 'unavailable', 'The source could not be reached.'],
      ]);
      expect(listed.items.every((item) => item.lastTestAt !== null)).toBe(true);
      const ready = await result.app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().sources).toEqual({ reachable: 1, unreachable: 1, unknown: 0 });
      const stored = await rows(database.ownerUrl, 'SELECT source_id, outcome, server_version, triggered_by FROM source_checks ORDER BY source_id');
      const tag = neo4jServer.image.split(':')[1] ?? '';
      expect(stored.map((row) => [row['source_id'], row['outcome'], row['triggered_by']])).toEqual([['alpha', 'pass', null], ['beta', 'fail', null]]);
      expect(String(stored[0]?.['server_version'])).toMatch(new RegExp(`^Neo4j ${tag.replace('.', '\\.')}(\\.|$)`));
      expect(stored[1]?.['server_version']).toBeNull();
    } finally {
      await stopApi(result);
    }
  });

  it('replaces the unknown state that an identity change leaves with the result of the new check', async () => {
    const database = await migrated();
    const first = mappingFile(sourceWith('alpha', { uri: neo4jServer.boltUri, database: neo4jServer.database, auth }));
    const started = await startApi({ DATABASE_URL: database.appUrl, NEBURYX_CONFIG: first, ...envFor(neo4jServer) });
    await stopApi(started.result);
    expect(await rows(database.ownerUrl, `SELECT state FROM sources WHERE id = 'alpha'`)).toEqual([{ state: 'connected' }]);
    const second = mappingFile(sourceWith('alpha', { uri: `bolt://127.0.0.1:${await freePort()}`, database: neo4jServer.database, auth }));
    const restarted = await startApi({ DATABASE_URL: database.appUrl, NEBURYX_CONFIG: second, ...envFor(neo4jServer) });
    await stopApi(restarted.result);
    expect(await rows(database.ownerUrl, `SELECT state, state_reason FROM sources WHERE id = 'alpha'`)).toEqual([{ state: 'unavailable', state_reason: 'The source could not be reached.' }]);
  });
});

describe(`the start with a mapping that does not fit the source, against the dev Neo4j server`, () => {
  const entities = [
    { type: 'node_a', label: 'Person', stable_id: 'id' },
    { type: 'node_b', label: 'Order Line', stable_id: 'id' },
  ];
  const base = { entities, relationships: [{ type: 'KNOWS', from: 'node_a', to: 'node_a' }] };
  const fixture = firstSource(mappingOf(sourceWith('seed')));

  async function startWith(overrides: Record<string, unknown>) {
    const database = await migrated();
    const file = mappingFile(sourceWith('alpha', { uri: neo4jServer.boltUri, database: neo4jServer.database, auth, ...base, ...overrides }));
    return { database, started: await startApi({ DATABASE_URL: database.appUrl, NEBURYX_CONFIG: file, ...envFor(neo4jServer) }) };
  }

  it('starts, and shows the source connected, for a mapping that fits', async () => {
    const { started } = await startWith({});
    if (started.result.exitCode !== 0) throw new Error('the API did not start');
    try {
      const listed = sourcesResponseSchema.parse((await started.result.app.inject({ method: 'GET', url: '/v1/sources' })).json());
      expect(listed.items.map((item) => [item.id, item.state])).toEqual([['alpha', 'connected']]);
    } finally {
      await stopApi(started.result);
    }
  });

  it.each([
    ['a label no node carries', { entities: [...entities, { type: 'ghost', label: 'Ghost', stable_id: 'gid' }] }, 'source alpha: Entity type "ghost" (label "Ghost"): no node carries the label'],
    ['a missing search index', { entities: [{ ...entities[0], search: ['nickname'] }, entities[1]] }, 'source alpha: Entity type "node_a" (label "Person"): no index on the search property "nickname"'],
    ['a missing reference index', { entities: [{ ...entities[0], reference: ['externalRef'] }, entities[1]] }, 'source alpha: Entity type "node_a" (label "Person"): no index on the reference property "externalRef"'],
    ['a missing evidence index', { relationships: [{ type: 'KNOWS', from: 'node_a', to: 'node_a', evidence: ['sourceRecord'] }] }, 'source alpha: Relationship type "KNOWS" from "node_a" to "node_a": no index on the evidence property "sourceRecord"'],
  ])('stops with exit 1 for %s, and the message names it and what to do', async (_name, overrides, line) => {
    const { database, started } = await startWith(overrides);
    expect(started.result.exitCode).toBe(1);
    expect(started.stderr).toBe(`${line}\nFix the source, then run test-source or test it from the Sources page.\n`);
    const stored = await rows(database.ownerUrl, 'SELECT source_id, outcome FROM source_checks');
    expect(stored).toEqual([{ source_id: 'alpha', outcome: 'fail' }]);
    expect(await rows(database.ownerUrl, `SELECT state FROM sources WHERE id = 'alpha'`)).toEqual([{ state: 'unavailable' }]);
  });

  it('stops with exit 1 for a stable id that is not unique, with an index and no constraint standing in', async () => {
    await dropConstraint(neo4jServer, constraintName('Person'));
    await runAdmin(neo4jServer, 'CREATE INDEX idx_Person_id_plain FOR (n:Person) ON (n.id)');
    await runAdmin(neo4jServer, "CREATE (:Person {id: 'twin'}), (:Person {id: 'twin'})");
    try {
      const { started } = await startWith({});
      expect(started.result.exitCode).toBe(1);
      expect(started.stderr).toContain('source alpha: Entity type "node_a" (label "Person"): 1 value occurs more than once in the stable id property "id"');
      expect(started.stderr).not.toContain('twin');
    } finally {
      await runAdmin(neo4jServer, "MATCH (n:Person {id: 'twin'}) DETACH DELETE n");
      await dropIndex(neo4jServer, 'idx_Person_id_plain');
      await createSchema(neo4jServer, fixture);
    }
  });
});

describe(`first contact against the dev Neo4j server`, () => {
  it('goes from not reachable, to unusable with the reason of a wrong mapping, to connected once the index is made and the source is tested', async () => {
    const late = await startNeo4j();
    const forwarder = await forwardTo(late.boltUri);
    try {
      await seedFixtureGraph(late);
      // the source is first reached at a closed port, the way a server that is not up yet is
      await forwarder.stop();
      const database = await migrated();
      const wrongMapping = { entities: [{ type: 'node_a', label: 'Person', stable_id: 'id', search: ['nickname'] }], relationships: [] };
      const file = mappingFile(sourceWith('alpha', { uri: forwarder.uri, database: late.database, auth, ...wrongMapping }));
      const { result } = await startApi({ DATABASE_URL: database.appUrl, NEBURYX_CONFIG: file, ...envFor(late) }, undefined, { pingIntervalMs: 300 });
      if (result.exitCode !== 0) throw new Error('the API did not start');
      try {
        const listed = async () => sourcesResponseSchema.parse((await result.app.inject({ method: 'GET', url: '/v1/sources' })).json()).items[0];
        expect(await listed()).toMatchObject({ state: 'unavailable', stateReason: 'The source could not be reached.' });
        await forwarder.resume();
        await vi.waitFor(
          async () =>
            expect(await listed()).toMatchObject({
              state: 'unavailable',
              stateReason: expect.stringMatching(/^The mapping does not fit the source: Entity type "node_a" \(label "Person"\): no index on the search property "nickname"\./),
            }),
          { timeout: 60_000, interval: 300 },
        );
        // the pings that follow keep that state, and do not bring back the stale one of the start
        await new Promise((resolve) => setTimeout(resolve, 900));
        expect(await listed()).toMatchObject({ state: 'unavailable', stateReason: expect.stringMatching(/^The mapping does not fit the source/) });
        await runAdmin(late, 'CREATE INDEX idx_Person_nickname FOR (n:Person) ON (n.nickname)');
        await runAdmin(late, 'CALL db.awaitIndexes(60)');
        const tested = await result.app.inject({ method: 'POST', url: '/v1/sources/alpha/test' });
        expect(tested.statusCode).toBe(200);
        expect(tested.json()).toMatchObject({ outcome: 'pass', state: 'connected' });
        expect(await listed()).toMatchObject({ state: 'connected', stateReason: null });
      } finally {
        await stopApi(result);
      }
    } finally {
      await runAll([() => forwarder.close(), () => late.stop()]);
    }
  });
});
