import neo4j, { type Driver } from 'neo4j-driver';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { createLogger } from '../logger.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { CYPHER_FRAGMENTS, UNICODE_SAMPLES } from '../testing/fuzz-corpus.js';
import { FUZZ_ENTITIES, FUZZ_RELATIONSHIPS } from '../testing/fuzz-rig.js';
import { TEST_REFERENCE_KEYS } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { makeWebRoot } from '../testing/web-root.js';

let server: RunningNeo4j;
let writer: Driver;
let parts: SourceGate;
let app: Awaited<ReturnType<typeof buildApp>>;
const webRoot = makeWebRoot();

async function run<T>(cypher: string, read: (rows: Record<string, unknown>[]) => T = () => undefined as T): Promise<T> {
  const session = writer.session({ database: server.database });
  try {
    const result = await session.run(cypher);
    return read(result.records.map((record) => record.toObject()));
  } finally {
    await session.close();
  }
}

/** What the database holds, in a form that changes when anything is added, removed or changed. */
async function fingerprint(): Promise<string> {
  const counts = await run('MATCH (n) OPTIONAL MATCH (n)-[r]->() RETURN count(DISTINCT n) AS nodes, count(r) AS relationships', (rows) => rows.map((row) => `${String(row['nodes'])}/${String(row['relationships'])}`));
  const labels = await run('MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS c ORDER BY label', (rows) => rows.map((row) => `${String(row['label'])}:${String(row['c'])}`));
  const properties = await run('MATCH (n) UNWIND keys(n) AS key RETURN key, count(*) AS c ORDER BY key', (rows) => rows.map((row) => `${String(row['key'])}:${String(row['c'])}`));
  const indexes = await run('SHOW INDEXES YIELD name, state RETURN name, state ORDER BY name', (rows) => rows.map((row) => `${String(row['name'])}:${String(row['state'])}`));
  const constraints = await run('SHOW CONSTRAINTS YIELD name RETURN name ORDER BY name', (rows) => rows.map((row) => String(row['name'])));
  return JSON.stringify({ counts, labels, properties, indexes, constraints });
}

beforeAll(async () => {
  server = await startNeo4j();
  const login = await server.createLogin('writer');
  writer = neo4j.driver(server.boltUri, neo4j.auth.basic(login.user, login.password));
  // schema only, through the harness's helper, in the database this run made; the data below is written with the run's own writer login
  for (const entity of FUZZ_ENTITIES) {
    await runAdmin(server, `CREATE CONSTRAINT stable_${entity.type} FOR (n:\`${entity.label}\`) REQUIRE n.\`${entity.stable_id}\` IS UNIQUE`);
    for (const property of [...entity.search, ...(entity.reference ?? [])].filter((name) => name !== entity.stable_id)) await runAdmin(server, `CREATE INDEX idx_${entity.type}_${property} FOR (n:\`${entity.label}\`) ON (n.\`${property}\`)`);
  }
  for (const row of FUZZ_RELATIONSHIPS) for (const property of row.evidence ?? []) await runAdmin(server, `CREATE INDEX rel_${row.type}_${property} FOR ()-[r:\`${row.type}\`]-() ON (r.\`${property}\`)`);
  await run("UNWIND range(1, 30) AS i CREATE (w:Widget {widgetId: 'W-' + i, nickname: 'needle', batchRef: 'needle', ownerName: 'Owner ' + i}) CREATE (g:Gadget {gadgetId: 'GD-' + i, region: 'north'}) CREATE (w)-[:MADE_FROM {linkId: 'L-' + i, recordId: 'needle', seenAt: datetime('2026-03-01T10:00:00Z')}]->(g)");
  await run("UNWIND range(1, 5) AS i CREATE (p:Handle {phoneNumber: '+1-212-555-010' + i}) WITH p MATCH (w:Widget {widgetId: 'W-1'}) CREATE (w)-[:USES {seenAt: datetime('2026-03-01T10:00:00Z')}]->(p)");
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
  const mapping = { sources: [sourceFor(server, { id: 'demo', entities: FUZZ_ENTITIES, relationships: FUZZ_RELATIONSHIPS })] };
  const defaults = communitySeams();
  parts = createSourceGate({ mapping, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined }, referenceKeys: TEST_REFERENCE_KEYS });
  const neverRefuses = { admit: () => undefined, inspect: () => new Map(), close: () => undefined };
  app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, seams: defaults, gate: parts.gate, indexes: parts.indexes, referenceKeys: TEST_REFERENCE_KEYS, limiter: neverRefuses });
}, 600_000);

afterAll(async () => {
  rmSync(webRoot, { recursive: true, force: true });
  await runAll([() => app?.close(), () => parts?.close(), () => writer?.close(), () => server?.stop()]);
});

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
const codeOf = (body: string): string | undefined => (JSON.parse(body) as { error?: { code?: string } }).error?.code;

const TEXTS = [...CYPHER_FRAGMENTS, ...UNICODE_SAMPLES.filter((text) => !/[\ud800-\udfff]/u.test(text) || /^(?:[^\ud800-\udfff]|[\ud800-\udbff][\udc00-\udfff])*$/u.test(text)), "' RETURN 1 //", 'x'.repeat(200)];

describe(`hostile input on the real adapter, on ${NEO4J_SERIES}`, () => {
  it('searches, looks up, previews and expands with every hostile text; the server reports no syntax error, the answers are those of an absent record, and the database is as it was', async () => {
    const before = await fingerprint();
    const failures: string[] = [];
    // accepted free text is served or, for a record that is not there, NOT_FOUND; any other code, INVALID_REQUEST included, is a failure
    const answer = async (name: string, url: string, body: unknown, allowed: readonly (string | undefined)[]) => {
      const response = await post(url, body);
      const code = codeOf(response.body);
      if (!allowed.includes(code)) failures.push(`${name}: ${response.statusCode} ${String(code)}`);
      return response;
    };
    const SERVED = [undefined];
    const SERVED_OR_ABSENT = [undefined, 'NOT_FOUND'];
    for (const text of TEXTS) {
      const label = JSON.stringify(text).slice(0, 40);
      const short = [...text].length < 2 ? 'xx' : text;
      for (const [kind, body] of [['search', { sourceId: 'demo', text: text.slice(0, 200) }], ['type-ahead', { sourceId: 'demo', text: short.slice(0, 200), typeahead: true }]] as const) {
        const response = await answer(`${kind} ${label}`, '/v1/search/entities', body, SERVED);
        if (response.statusCode === 200 && text === "' RETURN 1 //") {
          const result = JSON.parse(response.body) as { exact: unknown[]; related: { hits: unknown[] } };
          expect(result.exact.length + result.related.hits.length, label).toBe(0);
        }
      }
      await answer(`lookup ${label}`, '/v1/entities/lookup', { sourceId: 'demo', ref: { entityType: 'widget', stableId: text } }, SERVED_OR_ABSENT);
      await answer(`lookup value ${label}`, '/v1/entities/lookup', { sourceId: 'demo', value: { entityType: 'widget', value: text } }, SERVED_OR_ABSENT);
      await answer(`preview ${label}`, '/v1/graph/preview-expansion', { sourceId: 'demo', ref: { entityType: 'widget', stableId: text } }, SERVED_OR_ABSENT);
      await answer(`expand ${label}`, '/v1/graph/expand', { sourceId: 'demo', ref: { entityType: 'widget', stableId: text }, neighborTypes: ['gadget'] }, SERVED_OR_ABSENT);
      const refused = await post('/v1/graph/expand', { sourceId: 'demo', ref: { entityType: 'widget', stableId: 'W-1' }, neighborTypes: [text], relTypes: [text] });
      expect(codeOf(refused.body), label).toBe('INVALID_REQUEST');
    }
    expect(failures).toEqual([]);
    expect(await fingerprint()).toBe(before);
  });

  it('serves a benign search and expansion on the same graph, so the answers above are absence and not a broken rig', async () => {
    const search = await post('/v1/search/entities', { sourceId: 'demo', text: 'needle' });
    expect(search.statusCode).toBe(200);
    expect((JSON.parse(search.body) as { exact: unknown[] }).exact.length).toBeGreaterThan(0);
    const expand = await post('/v1/graph/expand', { sourceId: 'demo', ref: { entityType: 'widget', stableId: 'W-1' }, neighborTypes: ['gadget'] });
    expect(expand.statusCode).toBe(200);
  });

  it('refuses a cursor changed by one character, and a forged keyed token, and the database is as it was', async () => {
    const before = await fingerprint();
    const ask = (cursors?: Record<string, string>) => post('/v1/graph/expand', { sourceId: 'demo', ref: { entityType: 'widget', stableId: 'W-1' }, neighborTypes: ['phone'], limit: 2, ...(cursors === undefined ? {} : { cursors }) });
    const first = await ask();
    expect(first.statusCode).toBe(200);
    const cursor = (JSON.parse(first.body) as { pages: { nextCursor?: string }[] }).pages[0]?.nextCursor ?? '';
    expect(cursor).not.toBe('');
    expect((await ask({ phone: cursor })).statusCode).toBe(200);
    const tampered = `${cursor.slice(0, -2)}${cursor.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(codeOf((await ask({ phone: tampered })).body)).toBe('CURSOR_INVALIDATED');
    expect(codeOf((await post('/v1/graph/preview-expansion', { sourceId: 'demo', ref: { entityType: 'phone', stableId: 'p1.AAAA' } })).body)).toBe('INVALID_REQUEST');
    expect(await fingerprint()).toBe(before);
  });
});
