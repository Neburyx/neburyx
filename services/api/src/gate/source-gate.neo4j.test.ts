import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { auditing, integerTemplate, mappingOf, nodesTemplate, sourceWith } from '../testing/gate-fixtures.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, neo4jImageFrom, NEO4J_ENV_PASSWORD, NEO4J_ENV_USER, runAdmin, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-container.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { assembleGate } from './assemble.js';
import { createTemplateCatalog } from './catalog.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { connectivityTemplate } from './templates/connectivity.js';
import { SYSTEM_ID } from './system-principal.js';
import { markerTemplate } from '../testing/gate-fixtures.js';

let server: RunningNeo4j;
const events = auditing();

const sourceOptions = () => ({
  uri: server.boltUri,
  database: 'neo4j',
  auth: { kind: 'basic', username_env: NEO4J_ENV_USER, password_env: NEO4J_ENV_PASSWORD },
});

function openGate(): SourceGate {
  return createSourceGate({
    mapping: mappingOf(sourceWith('alpha', sourceOptions())),
    env: envFor(server),
    seams: events.seams,
    logger: { warn: () => undefined },
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
  return 'no error';
}

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'UNWIND range(1, 10) AS n CREATE (:Person {id: toString(n)})');
});

afterAll(async () => {
  await runAll([() => server?.stop()]);
});

describe(`the connectivity template on ${neo4jImageFrom(process.env)}`, () => {
  it('returns the server product, version and edition through the system runner, audited as the system principal', async () => {
    const parts = openGate();
    try {
      const page = await parts.system.run({ traceId: 'tr-connect', sourceId: 'alpha', templateId: 'connectivity', params: {}, limit: 1 });
      const tag = server.image.split(':')[1] ?? '';
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ product: 'Neo4j Kernel', edition: expect.any(String) });
      const version = String(Object.entries(page.items[0] ?? {}).find(([key]) => key === 'version')?.[1]);
      expect(version === tag || version.startsWith(`${tag}.`)).toBe(true);
      expect(events.events.at(-1)).toMatchObject({ actorId: SYSTEM_ID, actorRole: null, action: 'source.connectivity', result: 'success', sourceId: 'alpha' });
    } finally {
      await parts.close();
    }
  });

  it('answers SOURCE_UNAVAILABLE after close()', async () => {
    const parts = openGate();
    await parts.close();
    expect(await codeOf(parts.system.run({ traceId: 'tr-closed', sourceId: 'alpha', templateId: 'connectivity', params: {}, limit: 1 }))).toBe('SOURCE_UNAVAILABLE');
  });
});

describe('the user gate from createSourceGate', () => {
  it('runs the connectivity template as a user against the server and answers SOURCE_UNAVAILABLE after close()', async () => {
    const parts = openGate();
    const request = () => gateRequest({ sourceId: 'alpha', templateId: 'connectivity', params: {}, limit: 1 });
    const page = await parts.gate.run(request());
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ product: 'Neo4j Kernel' });
    expect(events.events.at(-1)).toMatchObject({ actorId: LOCAL_PRINCIPAL.id, action: 'source.connectivity', result: 'success' });
    await parts.close();
    expect(await codeOf(parts.gate.run(request()))).toBe('SOURCE_UNAVAILABLE');
  });
});

describe('templates with quoted names, the page limit and integer parameters, against the server', () => {
  const catalog = createTemplateCatalog({ templates: [connectivityTemplate, nodesTemplate, markerTemplate, integerTemplate] });
  const open = () => {
    const mapping = mappingOf(sourceWith('alpha', sourceOptions()));
    const executor = createNeo4jExecutor({ sources: mapping.sources, env: envFor(server), logger: { warn: () => undefined } });
    const parts = assembleGate({ mapping, seams: events.seams, executor, logger: { warn: () => undefined }, catalog });
    return { ...parts, close: () => executor.close() };
  };

  it('reads a label and a relationship type that contain a space', async () => {
    await runAdmin(server, "CREATE (:`Order Line` {id: 'l1'})<-[:`HAS LINE`]-(:Person {id: 'p1'})");
    const parts = open();
    try {
      const page = await parts.gate.run(gateRequest({ sourceId: 'alpha', templateId: 'marker-read', params: { kind: 'order_line', via: 'HAS LINE' }, limit: 5 }));
      expect(page.items).toEqual([]);
      const reverse = await parts.gate.run(gateRequest({ sourceId: 'alpha', templateId: 'marker-read', params: { kind: 'person', via: 'HAS LINE' }, limit: 5 }));
      expect(reverse.items).toEqual([{ id: 'p1' }]);
    } finally {
      await parts.close();
    }
  });

  it('reads either of two relationship types joined as a list', async () => {
    await runAdmin(server, "CREATE (:Person {id: 'k1'})-[:KNOWS]->(:Person {id: 'k2'}), (:Person {id: 'q1'})-[:`HAS LINE`]->(:`Order Line` {id: 'l2'})");
    const parts = open();
    try {
      const both = await parts.gate.run(gateRequest({ sourceId: 'alpha', templateId: 'marker-read', params: { kind: 'person', via: ['KNOWS', 'HAS LINE'] }, limit: 50 }));
      expect(both.items).toEqual(expect.arrayContaining([{ id: 'k1' }, { id: 'q1' }]));
      const knows = await parts.gate.run(gateRequest({ sourceId: 'alpha', templateId: 'marker-read', params: { kind: 'person', via: 'KNOWS' }, limit: 50 }));
      expect(knows.items).toEqual([{ id: 'k1' }]);
    } finally {
      await parts.close();
    }
  });

  it('returns exactly limit + 1 rows from the server for limit 3 and pages with hasMore', async () => {
    const parts = open();
    try {
      const page = await parts.gate.run(gateRequest({ sourceId: 'alpha', templateId: 'nodes-read', params: { kind: 'person' }, limit: 3 }));
      expect(page.items).toHaveLength(3);
      expect(page.hasMore).toBe(true);
      const all = await parts.gate.run(gateRequest({ sourceId: 'alpha', templateId: 'nodes-read', params: { kind: 'person' }, limit: 50 }));
      expect(all.items.length).toBeGreaterThan(3);
      expect(all.hasMore).toBe(false);
    } finally {
      await parts.close();
    }
  });

  it('sends a declared integer as a Cypher INTEGER', async () => {
    const parts = open();
    try {
      const page = await parts.gate.run(gateRequest({ sourceId: 'alpha', templateId: 'integer-read', params: { k: 7 }, limit: 1 }));
      expect(page.items).toEqual([{ t: 'INTEGER NOT NULL' }]);
    } finally {
      await parts.close();
    }
  });
});

describe('the adapter with the integer and limit settings', () => {
  it('sends an undeclared whole number as FLOAT, a declared one as INTEGER, and holds the server cap when the row limit is raised', async () => {
    const executor = createNeo4jExecutor({ sources: mappingOf(sourceWith('alpha', sourceOptions())).sources, env: envFor(server), logger: { warn: () => undefined } });
    const call = (cypher: string, overrides: object = {}) => ({
      sourceId: 'alpha',
      templateId: 'integers',
      templateVersion: '1',
      cypher,
      parameters: {},
      accessMode: 'READ' as const,
      timeoutMs: 10_000,
      rowLimit: 100,
      deadlineAt: Date.now() + 60_000,
      traceId: `integers-${Date.now()}`,
      ...overrides,
    });
    try {
      const declared = await executor.execute(call('RETURN valueType($k) AS t', { parameters: { k: 7 }, integerParameters: ['k'] }));
      const undeclared = await executor.execute(call('RETURN valueType($k) AS t', { parameters: { k: 2 } }));
      expect(declared).toEqual({ status: 'rows', rows: [{ t: 'INTEGER NOT NULL' }] });
      expect(undeclared).toEqual({ status: 'rows', rows: [{ t: 'FLOAT NOT NULL' }] });
      const capped = await executor.execute(call('MATCH (p:Person) RETURN p.id AS id LIMIT $limit + 1', { parameters: { limit: 3 }, rowLimit: 100 }));
      if (capped.status !== 'rows') throw new Error('expected rows');
      expect(capped.rows).toHaveLength(4);
    } finally {
      await executor.close();
    }
  });
});
