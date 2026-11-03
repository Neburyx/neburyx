import neo4j from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdapterError } from './errors.js';
import { createNeo4jExecutor, type Neo4jExecutor } from './executor.js';
import type { ExecuteCall } from '../gate/executor.js';
import { envFor, neo4jImageFrom, runAdmin, runAll, seedItems, SLOW_READ, sourceFor, startNeo4j, waitUntilNotListed, type RunningNeo4j } from '../testing/neo4j-container.js';

let server: RunningNeo4j;
let executor: Neo4jExecutor;
let sequence = 0;

function numberOf(value: unknown): number {
  if (typeof value !== 'number') throw new Error('expected a plain number');
  return value;
}

function call(cypher: string, overrides: Partial<ExecuteCall> = {}): ExecuteCall {
  sequence += 1;
  return {
    sourceId: 'graph',
    templateId: 'test-read',
    templateVersion: '1',
    cypher,
    parameters: {},
    accessMode: 'READ',
    timeoutMs: 10_000,
    rowLimit: 5,
    deadlineAt: Date.now() + 60_000,
    traceId: `trace-${sequence}-${Date.now()}`,
    ...overrides,
  };
}

async function rowsOf(cypher: string, overrides: Partial<ExecuteCall> = {}): Promise<readonly Record<string, unknown>[]> {
  const outcome = await executor.execute(call(cypher, overrides));
  if (outcome.status !== 'rows') throw new Error(`expected rows, got ${outcome.status}`);
  return outcome.rows;
}

beforeAll(async () => {
  server = await startNeo4j();
  await seedItems(server);
  await runAdmin(server, "CREATE (a:Thing {id: 1})-[:LINKS {since: date('2020-01-01')}]->(b:Thing {id: 2})");
  executor = createNeo4jExecutor({
    sources: [sourceFor(server), sourceFor(server, { id: 'system-db', database: 'system' })],
    env: envFor(server),
    logger: { warn: () => undefined },
  });
});

afterAll(async () => {
  await runAll([() => executor?.close(), () => server?.stop()]);
});

describe(`the server of ${neo4jImageFrom(process.env)}`, () => {
  it('is the version the image names', async ({ annotate }) => {
    const session = server.admin.session({ database: 'system' });
    const result = await session.run('CALL dbms.components() YIELD versions RETURN versions[0] AS version');
    await session.close();
    const version = String(result.records[0]?.get('version'));
    const tag = server.image.split(':')[1] ?? '';
    expect(/^\d/.test(tag), `the image tag ${tag} names a version`).toBe(true);
    await annotate(`${server.image} runs server ${version}`);
    expect(version === tag || version.startsWith(`${tag}.`), `server ${version} for image ${server.image}`).toBe(true);
  });
});

describe('rows from a Neo4j container', () => {
  it('answers exactly the row limit for a query that keeps producing, without waiting for it, and the transaction leaves the server', async () => {
    const traceId = `cap-${Date.now()}`;
    const started = Date.now();
    const outcome = await executor.execute(call('UNWIND range(1, 1000000000) AS i RETURN i', { traceId }));
    expect(Date.now() - started).toBeLessThan(10_000);
    if (outcome.status !== 'rows') throw new Error(`expected rows, got ${outcome.status}`);
    expect(outcome.rows.map((row) => numberOf(row['i']))).toEqual([1, 2, 3, 4, 5]);
    expect(await waitUntilNotListed(server, traceId, 30_000)).toBe(true);
  });

  it('answers all rows when there are fewer than the limit, and an empty list for none', async () => {
    expect(await rowsOf('UNWIND range(1, 2) AS i RETURN i')).toHaveLength(2);
    expect(await rowsOf('UNWIND [] AS i RETURN i')).toEqual([]);
  });

  it('passes parameters that look like query text as plain values', async () => {
    const text = "'; MATCH (n) DETACH DELETE n //";
    expect(await rowsOf('RETURN $value AS value', { parameters: { value: text } })).toEqual([{ value: text }]);
    expect(await rowsOf('MATCH (t:Thing) RETURN count(t) AS things')).toHaveLength(1);
  });

  it('hands over plain values: 64-bit integers, date and time, node, relationship and path are tagged, JSON-safe objects, never driver objects', async () => {
    const [row] = await rowsOf(
      "MATCH p = (a:Thing)-[r:LINKS]->(b:Thing) RETURN 9007199254740993 AS big, datetime('2026-01-02T03:04:05Z') AS at, date('2026-01-02') AS day, duration('P1DT2H') AS span, a, r, p",
    );
    expect(row?.['big']).toEqual({ $type: 'integer', value: '9007199254740993' });
    expect(row?.['at']).toMatchObject({ $type: 'dateTime' });
    expect(row?.['day']).toEqual({ $type: 'date', value: '2026-01-02' });
    expect(row?.['span']).toEqual({ $type: 'duration', value: 'P1DT2H' });
    expect(row?.['a']).toMatchObject({ $type: 'node', labels: ['Thing'] });
    expect(row?.['r']).toMatchObject({ $type: 'relationship', type: 'LINKS' });
    expect(row?.['p']).toMatchObject({ $type: 'path' });
    expect(JSON.parse(JSON.stringify(row))).toEqual(row);
    for (const value of Object.values(row ?? {})) {
      expect(neo4j.isInt(value) || neo4j.isDateTime(value) || neo4j.isDate(value) || neo4j.isDuration(value) || neo4j.isNode(value) || neo4j.isRelationship(value) || neo4j.isPath(value)).toBe(false);
    }
  });

  it('reads the database the mapping names for each source', async () => {
    const named = 'CALL db.info() YIELD name RETURN name';
    expect(await rowsOf(named)).toEqual([{ name: 'neo4j' }]);
    const outcome = await executor.execute(call(named, { sourceId: 'system-db' }));
    expect(outcome).toEqual({ status: 'rows', rows: [{ name: 'system' }] });
  });
});

describe('a read that outlives its timeout', () => {
  it('answers timeout, and the same executor then answers a normal read', async () => {
    const outcome = await executor.execute(call(SLOW_READ, { timeoutMs: 1000 }));
    expect(outcome).toEqual({ status: 'timeout' });
    expect(await rowsOf('MATCH (i:Item) WHERE i.n < 5 RETURN count(i) AS found')).toHaveLength(1);
  });

  it('answers timeout from the deadline when the deadline is nearer than the call timeout', async () => {
    const started = Date.now();
    const outcome = await executor.execute(call(SLOW_READ, { timeoutMs: 30_000, deadlineAt: Date.now() + 1500 }));
    expect(outcome).toEqual({ status: 'timeout' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('a query the server refuses', () => {
  it('is thrown as an AdapterError, and neither it nor the logs hold the query text, a parameter or a row', async () => {
    const logs: { fields: object; message: string }[] = [];
    const local = createNeo4jExecutor({ sources: [sourceFor(server)], env: envFor(server), logger: { warn: (fields, message) => logs.push({ fields, message }) } });
    try {
      const attempt = local.execute(call('RETURN MARKER_QUERY_TEXT + $p AS value', { parameters: { p: 'MARKER_PARAMETER' } }));
      await expect(attempt).rejects.toThrow(AdapterError);
      const error = await attempt.catch((caught: unknown) => caught);
      const text = JSON.stringify([String(error), logs]);
      expect(text).not.toContain('MARKER_QUERY_TEXT');
      expect(text).not.toContain('MARKER_PARAMETER');
      expect(logs).toHaveLength(1);
      expect(logs[0]?.fields).toMatchObject({ event: 'source.read_failed', sourceId: 'graph' });
    } finally {
      await local.close();
    }
  });
});
