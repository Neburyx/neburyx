import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleGate } from '../gate/assemble.js';
import type { Gate, IndexReader } from '../gate/types.js';
import { createSourceAccess } from '../investigations/source-access.js';
import type { SourceModel } from '../mapping/model.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { createNeo4jExecutor, type Neo4jExecutor } from '../sources/executor.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { communityAccess } from '../testing/source-access.js';
import { aggregateHits, storedHits } from '../testing/search-fixtures.js';
import { AppError } from '../errors.js';
import { SEARCH_EVIDENCE_ID } from '../gate/templates/search-evidence.js';
import { createSearchService } from './search-service.js';

const SMALL_PAGE = 10;
const ENTITIES = [
  { type: 'item', label: 'Item', stable_id: 'sid' },
  { type: 'thing', label: 'Thing', stable_id: 'sid' },
];
const row = (type: string) => ({ type, from: 'item', to: 'thing', stable_id: 'lid', evidence: ['rec'] });
const RELATIONSHIPS = [...['FOUND_BY_RANGE', 'FOUND_BY_TEXT', 'BULK', 'DROPME', 'INT_RANGE', 'TEXT_ONLY'].map(row), { type: 'AGG_DROP', from: 'item', to: 'thing', evidence: ['rec'] }];
const SMALL_RELATIONSHIPS = [row('SMALL')];

interface Rig {
  readonly gate: Gate;
  readonly indexes: IndexReader;
  readonly close: () => Promise<void>;
}

let server: RunningNeo4j;
let big: Rig;
let small: Rig;
let denied: Rig;
const statements: { readonly templateId: string; readonly cypher: string }[] = [];
const events: AuditEvent[] = [];

const sourceOf = (relationships: readonly object[], overrides: Record<string, unknown> = {}): SourceModel => sourceFor(server, { entities: ENTITIES, relationships, ...overrides });

function rigFor(source: SourceModel, seamsOverride: Partial<Pick<Seams, 'policy'>> = {}): Rig {
  const defaults = communitySeams();
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = { policy: seamsOverride.policy ?? defaults.policy, coordinator: defaults.coordinator, audit: { record: (event) => Promise.resolve(void events.push(event)) } };
  const executor = createNeo4jExecutor({ sources: [source], env: envFor(server), logger: { warn: () => undefined } });
  const recording: Neo4jExecutor = { ...executor, execute: (call) => (statements.push({ templateId: call.templateId, cypher: call.cypher }), executor.execute(call)) };
  const assembled = assembleGate({ mapping: { sources: [source] }, seams, executor: recording, logger: { warn: () => undefined } });
  return { gate: assembled.gate, indexes: assembled.indexes, close: () => executor.close() };
}

const bulk = (type: string, rec: string, size: number, prefix: string) =>
  runAdmin(server, `MATCH (i:Item {sid: 'I-1'}), (t:Thing {sid: 'T-1'}) UNWIND range(1, ${size}) AS k CREATE (i)-[:${type} {lid: '${prefix}-' + k, rec: '${rec}'}]->(t)`);

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, "CREATE (:Item {sid: 'I-1', name: 'Endpoint Item'}), (:Thing {sid: 'T-1', name: 'Endpoint Thing'})");
  for (const type of ['FOUND_BY_RANGE', 'BULK', 'DROPME', 'INT_RANGE', 'SMALL', 'AGG_DROP']) await runAdmin(server, `CREATE INDEX ${type.toLowerCase()}_rec FOR ()-[r:${type}]-() ON (r.rec)`);
  for (const type of ['FOUND_BY_TEXT', 'TEXT_ONLY']) await runAdmin(server, `CREATE TEXT INDEX ${type.toLowerCase()}_rec FOR ()-[r:${type}]-() ON (r.rec)`);
  await runAdmin(server, "MATCH (i:Item {sid: 'I-1'}), (t:Thing {sid: 'T-1'}) CREATE (i)-[:FOUND_BY_RANGE {lid: 'FR-1', rec: 'REC-1'}]->(t), (i)-[:FOUND_BY_TEXT {lid: 'FT-1', rec: 'REC-1'}]->(t), (i)-[:DROPME {lid: 'DP-1', rec: 'drop-me'}]->(t)");
  for (const size of [24, 25, 26]) await bulk('BULK', `bulk-${size}`, size, `BK${size}`);
  for (const size of [SMALL_PAGE - 1, SMALL_PAGE, SMALL_PAGE + 1]) await bulk('SMALL', `small-${size}`, size, `SM${size}`);
  await runAdmin(server, "MATCH (i:Item {sid: 'I-1'}), (t:Thing {sid: 'T-1'}) CREATE (i)-[:INT_RANGE {lid: 'IR-1', rec: 9007199254740993}]->(t), (i)-[:INT_RANGE {lid: 'IR-2', rec: 9007199254740992}]->(t), (i)-[:INT_RANGE {lid: 'IR-3', rec: 9007199254740994}]->(t), (i)-[:INT_RANGE {lid: 'IR-4', rec: '9007199254740993'}]->(t)");
  await runAdmin(server, "MATCH (i:Item {sid: 'I-1'}), (t:Thing {sid: 'T-1'}) CREATE (i)-[:TEXT_ONLY {lid: 'TO-1', rec: '123'}]->(t), (i)-[:TEXT_ONLY {lid: 'TO-2', rec: 123}]->(t)");
  await runAdmin(server, "MATCH (i:Item {sid: 'I-1'}), (t:Thing {sid: 'T-1'}) CREATE (i)-[:AGG_DROP {rec: 'agg-drop'}]->(t), (i)-[:AGG_DROP {rec: 'agg-drop'}]->(t)");
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
  big = rigFor(sourceOf(RELATIONSHIPS));
  const smallPage = { budgets: { max_page: SMALL_PAGE, default_page: SMALL_PAGE } };
  small = rigFor(sourceOf(SMALL_RELATIONSHIPS, smallPage));
  denied = rigFor(sourceOf(RELATIONSHIPS), { policy: { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'not for this person' }) } });
}, 600_000);

afterAll(async () => {
  await runAll([() => big?.close(), () => small?.close(), () => denied?.close(), () => server?.stop()]);
});

const service = (rig: Rig, source: SourceModel) => createSearchService({ gate: rig.gate, indexes: rig.indexes, mapping: { sources: [source] }, access: communityAccess({ sources: [source] }) });
const search = (text: string, mask = false) => service(big, sourceOf(RELATIONSHIPS)).search({ traceId: 'tr-evidence', principal: LOCAL_PRINCIPAL, sourceId: 'graph', text, mask });
const evidenceStatements = (from = 0) => statements.slice(from).filter((statement) => statement.templateId === 'relationship-evidence');
const idsOf = async (text: string) => storedHits((await search(text)).evidence.hits).map((hit) => hit.supports.stableId).sort();

describe(`the evidence records of a search on ${NEO4J_SERIES}`, () => {
  it('finds the relationships that carry the typed record ID under a RANGE index and a TEXT-only index, with references that name their type and ends', async () => {
    const answer = await search('REC-1');
    expect(storedHits(answer.evidence.hits).map((hit) => hit.supports)).toEqual([
      { sourceId: 'graph', type: 'FOUND_BY_RANGE', from: 'item', to: 'thing', stableId: 'FR-1' },
      { sourceId: 'graph', type: 'FOUND_BY_TEXT', from: 'item', to: 'thing', stableId: 'FT-1' },
    ]);
    expect(storedHits(answer.evidence.hits).every((hit) => JSON.stringify(hit.records) === JSON.stringify([{ sourceRecordId: 'REC-1' }]))).toBe(true);
    expect(answer.evidence.count).toEqual({ value: 2, quality: 'exact', scope: 'search:evidence' });
    expect(JSON.stringify(answer.evidence)).not.toContain('Endpoint');
  });

  it('finds nothing for an ID no relationship carries', async () => {
    const answer = await search('nobody-carries-this');
    expect(answer.evidence.hits).toEqual([]);
    expect(answer.evidence.count).toEqual({ value: 0, quality: 'exact', scope: 'search:evidence' });
  });
});

describe(`the cap and the count of the evidence group on ${NEO4J_SERIES}`, () => {
  it.each([
    [24, 24, 'exact'],
    [25, 25, 'exact'],
    [26, 25, 'lowerBound'],
  ])('shows %i relationships as %i hits and an %s count', async (relationships, hits, quality) => {
    const answer = await search(`bulk-${relationships}`);
    expect(answer.evidence.hits).toHaveLength(hits);
    expect(answer.evidence.count).toEqual({ value: hits, quality, scope: 'search:evidence' });
    expect(answer.cap).toBe(25);
  });

  it.each([
    [SMALL_PAGE - 1, SMALL_PAGE - 1, 'exact'],
    [SMALL_PAGE, SMALL_PAGE, 'exact'],
    [SMALL_PAGE + 1, SMALL_PAGE, 'lowerBound'],
  ])('shows %i relationships as %i hits and an %s count for a source whose max_page is 10', async (relationships, hits, quality) => {
    const source = sourceOf(SMALL_RELATIONSHIPS, { budgets: { max_page: SMALL_PAGE, default_page: SMALL_PAGE } });
    const answer = await service(small, source).search({ traceId: 'tr-small', principal: LOCAL_PRINCIPAL, sourceId: 'graph', text: `small-${relationships}`, mask: false });
    expect(answer.evidence.hits).toHaveLength(hits);
    expect(answer.evidence.count).toEqual({ value: hits, quality, scope: 'search:evidence' });
    expect(answer.cap).toBe(SMALL_PAGE);
  });
});

describe(`how the evidence read matches a value on ${NEO4J_SERIES}`, () => {
  it('matches a 64-bit integer above 2^53 under a RANGE index without rounding, and the same text as stored text', async () => {
    expect(await idsOf('9007199254740993')).toEqual(['IR-1', 'IR-4']);
    expect(await idsOf('9007199254740992')).toEqual(['IR-2']);
    expect(await idsOf('9007199254740994')).toEqual(['IR-3']);
  });

  it('matches the text of a number under a TEXT index as stored text only, and not an integer-valued property', async () => {
    expect(await idsOf('123')).toEqual(['TO-1']);
  });
});

describe(`an unreadable source, on ${NEO4J_SERIES}`, () => {
  it('answers NOT_FOUND and sends no statement to the server', async () => {
    const source = sourceOf(RELATIONSHIPS);
    const from = statements.length;
    const access = createSourceAccess({ mapping: { sources: [source] }, seams: { policy: { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'not for this person' }) }, audit: { record: () => Promise.resolve() } }, logger: { warn: () => undefined } });
    const refused = createSearchService({ gate: denied.gate, indexes: denied.indexes, mapping: { sources: [source] }, access });
    await expect(refused.search({ traceId: 'tr-denied', principal: LOCAL_PRINCIPAL, sourceId: 'graph', text: 'REC-1', mask: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(statements.slice(from)).toEqual([]);
  });
});

describe(`a relationship index that is gone since the check, on ${NEO4J_SERIES}`, () => {
  it('is left out of the next search with its row named, and no statement of the evidence read names its type, so no scan can have run', async () => {
    expect(await idsOf('drop-me')).toEqual(['DP-1']);
    await runAdmin(server, 'DROP INDEX dropme_rec');
    const from = statements.length;
    const answer = await search('drop-me');
    expect(answer.evidence.disabledRelationshipTypes).toContainEqual({ relationshipType: 'DROPME', from: 'item', to: 'thing', property: 'rec', reason: 'index-unavailable' });
    expect(storedHits(answer.evidence.hits).filter((hit) => hit.supports.type === 'DROPME')).toEqual([]);
    expect(evidenceStatements(from).filter((statement) => statement.cypher.includes('`DROPME`'))).toEqual([]);
    await runAdmin(server, 'CREATE INDEX dropme_rec FOR ()-[r:DROPME]-() ON (r.rec)');
    await runAdmin(server, 'CALL db.awaitIndexes(120)');
    expect(await idsOf('drop-me')).toEqual(['DP-1']);
  });
});

describe(`the index of a relationship row with no stable ID, on ${NEO4J_SERIES}`, () => {
  const handWritten = async (): Promise<string> => {
    const snapshot = await big.indexes.read({ traceId: 'tr-agg-guard', principal: LOCAL_PRINCIPAL, sourceId: 'graph' });
    try {
      await big.gate.run({ traceId: 'tr-agg-guard', principal: LOCAL_PRINCIPAL, sourceId: 'graph', templateId: SEARCH_EVIDENCE_ID, params: { text: 'agg-drop', targets: [{ relationshipType: 'AGG_DROP', from: 'item', to: 'thing', property: 'rec', match: 'value' }] }, limit: 25, indexes: snapshot });
      return 'ok';
    } catch (error) {
      return error instanceof AppError ? `${error.code} ${String(error.reason)}` : 'not an AppError';
    }
  };

  it('is sought as for a row with one: found while its index is online; once it is gone the property is named, no statement names its type, and a read written by hand is refused', async () => {
    const found = await search('agg-drop');
    expect(aggregateHits(found.evidence.hits).map((hit) => hit.members.length)).toEqual([2]);
    await runAdmin(server, 'DROP INDEX agg_drop_rec');
    const from = statements.length;
    const answer = await search('agg-drop');
    expect(answer.evidence.disabledRelationshipTypes).toContainEqual({ relationshipType: 'AGG_DROP', from: 'item', to: 'thing', property: 'rec', reason: 'index-unavailable' });
    expect(aggregateHits(answer.evidence.hits)).toEqual([]);
    expect(await handWritten()).toBe('SOURCE_UNAVAILABLE index-unavailable');
    expect(statements.slice(from).filter((statement) => statement.cypher.includes('`AGG_DROP`'))).toEqual([]);
    await runAdmin(server, 'CREATE INDEX agg_drop_rec FOR ()-[r:AGG_DROP]-() ON (r.rec)');
    await runAdmin(server, 'CALL db.awaitIndexes(120)');
    expect(aggregateHits((await search('agg-drop')).evidence.hits).map((hit) => hit.members.length)).toEqual([2]);
  });
});
