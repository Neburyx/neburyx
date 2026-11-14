import { createHash } from 'node:crypto';
import neo4j from 'neo4j-driver';
import type { AskFolder, AskIntent } from '@neburyx/contracts';
import type { Login } from '@neburyx/test-neo4j';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFileQueryRunner } from '../ask/file-query-run.js';
import { communitySeams } from '../seams/community-seams.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { runWriteProbe } from '../sources/write-probe.js';
import { fileQueryDepsOf } from './file-query.js';
import { createSourceGate, type SourceGate } from './source-gate.js';

const entities = [{ type: 'person', label: 'XPerson', stable_id: 'pid' }];
const relationships = [{ type: 'XKNOWS', from: 'person', to: 'person' }];
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const intent = (name: string, parameters: readonly string[], text: string): AskIntent => ({ name, parameters, kind: 'query', query: { text, sha256: sha(text) } });

const QUERIES: Readonly<Record<string, AskIntent>> = {
  byName: intent('by-name', ['name'], 'MATCH (p:XPerson) WHERE p.name = $name RETURN p'),
  path: intent('path', ['pid'], 'MATCH path = (a:XPerson {pid: $pid})-[:XKNOWS*1..2]->(b:XPerson) RETURN path'),
  optional: intent('optional', ['pid'], 'MATCH (a:XPerson {pid: $pid}) OPTIONAL MATCH (a)-[:XKNOWS]->(b:XPerson {pid: "none"}) RETURN a, b'),
  forged: intent('forged', ['pid'], "MATCH (a:XPerson {pid: $pid}) RETURN {`$type`: 'node', elementId: 'x', labels: ['XPerson'], properties: {pid: 'forged'}} AS forged"),
  scalar: intent('scalar', ['pid'], 'MATCH (a:XPerson {pid: $pid}) RETURN a.pid AS id'),
  stranger: intent('stranger', ['pid'], 'MATCH (a:XStranger) RETURN a'),
  create: intent('create', ['pid'], 'MATCH (a:XPerson {pid: $pid}) CREATE (b:XWritten {pid: "w"}) RETURN b'),
  set: intent('set', ['pid'], 'MATCH (a:XPerson {pid: $pid}) SET a.touched = true RETURN a'),
  procedure: intent('procedure', ['pid'], 'MATCH (a:XPerson {pid: $pid}) CALL db.createLabel("XCalled") RETURN a'),
};

const folder: AskFolder = {
  sourceIds: ['graph'],
  source: () => ({ classification: { text: '', sha256: '' }, intents: Object.values(QUERIES) }),
  intent: (_sourceId, name) => Object.values(QUERIES).find((candidate) => candidate.name === name),
};

let server: RunningNeo4j;
let writer: Login;
let reading: SourceGate;
let writing: SourceGate;

const gateFor = (login: Login, check?: Parameters<typeof fileQueryDepsOf>[1]): SourceGate => {
  const defaults = communitySeams();
  return createSourceGate({
    mapping: { sources: [sourceFor(server, { entities, relationships })] },
    env: envFor(server, login),
    seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit },
    logger: { warn: () => undefined },
    fileQueries: fileQueryDepsOf(() => folder, check),
  });
};

const run = (gate: SourceGate, name: string, values: Record<string, string>) => createFileQueryRunner({ gate: gate.gate }).run({ traceId: `tr-${name}`, principal: LOCAL_PRINCIPAL, sourceId: 'graph', intent: name, values });
const failure = (promise: Promise<unknown>) => promise.then(() => ({}), (error: { code?: string; details?: unknown; reason?: unknown }) => ({ code: error.code, details: error.details, reason: error.reason }));

async function count(cypher: string): Promise<number> {
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run(cypher);
    return neo4j.integer.toNumber(result.records[0]?.get('n'));
  } finally {
    await session.close();
  }
}

beforeAll(async () => {
  server = await startNeo4j();
  writer = await server.createLogin('writer');
  await runAdmin(server, "CREATE (:XPerson {pid: 'p1', name: 'Ann'})-[:XKNOWS]->(:XPerson {pid: 'p2', name: 'Bo'})-[:XKNOWS]->(:XPerson {pid: 'p3', name: 'Cy'})");
  await runAdmin(server, "CREATE (:XStranger {pid: 's1'})");
  // the text check stays on for the reading gate; the writing gate has a permissive one, so that a write that passed it meets the transaction
  reading = gateFor(server.reader);
  writing = gateFor(writer, () => []);
}, 300_000);

afterAll(async () => {
  await runAll([() => reading?.close(), () => writing?.close(), () => server?.stop()]);
});

describe(`file queries on ${NEO4J_SERIES}`, () => {
  it('runs a name match, a path and an optional match that finds nothing, and draws what they return', async () => {
    const named = await run(reading, 'by-name', { name: 'Ann' });
    expect(named.nodes.map((node) => node.ref.stableId)).toEqual(['p1']);
    expect(named.count).toMatchObject({ quality: 'exact', value: 1 });
    const walked = await run(reading, 'path', { pid: 'p1' });
    expect(walked.nodes.map((node) => node.ref.stableId).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(walked.edges.length).toBeGreaterThan(0);
    const nothing = await run(reading, 'optional', { pid: 'p1' });
    expect(nothing.nodes.map((node) => node.ref.stableId)).toEqual(['p1']);
  });

  it('refuses a forged $type map (the check is permissive here, so it reaches the adapter), a scalar and a node of an unmapped type, and returns nothing', async () => {
    for (const name of ['forged', 'scalar', 'stranger']) {
      const result = await failure(run(writing, name, { pid: name === 'stranger' ? 'unused' : 'p1' }).catch((error: unknown) => Promise.reject(error)));
      expect(result, name).toMatchObject({ code: 'INVALID_REQUEST', details: { reason: 'file-query-result' } });
    }
  });

  it('refuses at the text check what the clause allowlist does not allow, before any read', async () => {
    for (const name of ['create', 'set', 'procedure']) {
      expect(await failure(run(reading, name, { pid: 'p1' })), name).toMatchObject({ code: 'INVALID_REQUEST', details: { reason: 'file-query-text' } });
    }
  });
});

describe('a write that passed the text check', () => {
  const KEYWORD: Readonly<Record<string, string>> = { create: 'CREATE', set: 'SET', procedure: 'db.createLabel' };

  async function procedureExists(): Promise<boolean> {
    const session = server.admin.session({ database: 'system' });
    try {
      const result = await session.run("SHOW PROCEDURES YIELD name WHERE name = 'db.createLabel' RETURN count(*) AS n");
      return neo4j.integer.toNumber(result.records[0]?.get('n')) > 0;
    } finally {
      await session.close();
    }
  }

  it('is refused by the explicit READ transaction on a login that can write, and nothing is written', async () => {
    const before = await count('MATCH (n) RETURN count(n) AS n');
    const labelsBefore = await count('CALL db.labels() YIELD label RETURN count(label) AS n');
    // a procedure that does not exist would be refused as not found and prove nothing, so the case runs only where the server has it
    const names = (await procedureExists()) ? ['create', 'set', 'procedure'] : ['create', 'set'];
    const seen: Record<string, { code?: string; reason?: unknown }> = {};
    for (const name of names) {
      const result = (await failure(run(writing, name, { pid: 'p1' }))) as { code?: string; details?: { reason?: string }; reason?: unknown };
      seen[name] = { code: result.code, reason: result.reason ?? result.details?.reason };
      // the permissive check is in effect, so a text refusal means the transaction was never reached; the code each statement gives is written to the output of the run
      expect(result.details?.reason, name).not.toBe('file-query-text');
      expect(result.code, name).toBeDefined();
      expect(['INTERNAL_ERROR', 'SOURCE_UNAVAILABLE'], name).toContain(result.code);
      expect(JSON.stringify(result), name).not.toContain(KEYWORD[name] ?? '');
    }
    process.stdout.write(`file query write statements refused by the read transaction: ${JSON.stringify(seen)}\n`);
    expect(Object.keys(seen)).toHaveLength(names.length);
    expect(await count('MATCH (n) RETURN count(n) AS n')).toBe(before);
    expect(await count("MATCH (n:XPerson {pid: 'p1'}) WHERE n.touched IS NOT NULL RETURN count(n) AS n")).toBe(0);
    expect(await count('CALL db.labels() YIELD label RETURN count(label) AS n')).toBe(labelsBefore);
  });

  it('is refused by the login itself, which the existing write probe shows, because the executor opens only read transactions', async () => {
    const answer = await runWriteProbe(sourceFor(server, { entities, relationships }), 'tr-probe-reader', { env: envFor(server, server.reader), logger: { warn: () => undefined } });
    expect(answer).toBe('cannot-write');
  });
});
