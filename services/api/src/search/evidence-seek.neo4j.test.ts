import { warningsOf } from '../gate/normalize/drops.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { assembleGate } from '../gate/assemble.js';
import { createTemplateCatalog, type TemplateDefinition } from '../gate/catalog.js';
import { renderTemplate } from '../gate/render.js';
import { searchEvidenceTemplate } from '../gate/templates/search-evidence.js';
import { searchExactTemplate } from '../gate/templates/search-exact.js';
import type { Gate, IndexReader, SystemRunner } from '../gate/types.js';
import type { SourceModel } from '../mapping/model.js';
import { communitySeams } from '../seams/community-seams.js';
import { createNeo4jExecutor, type Neo4jExecutor } from '../sources/executor.js';
import { prepareParameters } from '../sources/parameters.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { communityAccess } from '../testing/source-access.js';
import { aggregateHits, storedHits } from '../testing/search-fixtures.js';
import { createSearchService } from './search-service.js';

const PROFILED = 'test-evidence-profiled';
const COMMON_MATCHES = 3000;
const ENTITIES = [
  { type: 'item', label: 'Item', stable_id: 'sid', search: ['sid'], reference: ['ref'] },
  { type: 'thing', label: 'Thing', stable_id: 'sid' },
];
const row = (type: string, evidence: readonly string[] = ['rec']) => ({ type, from: 'item', to: 'thing', stable_id: 'lid', evidence });
const RELATIONSHIPS = [row('COMMON'), row('TEXTED'), row('DROPS'), row('WRONG'), row('PAIR', ['rec', 'doc']), row('TWIN_A'), row('TWIN_B'), { type: 'BULK', from: 'item', to: 'thing', observed_at: 'at', evidence: ['rec', 'doc'] }];
const BULK_MATCHES = 30;

let server: RunningNeo4j;
let rig: { readonly gate: Gate; readonly indexes: IndexReader; readonly close: () => Promise<void> };
let profiling: { readonly system: SystemRunner; readonly executor: Neo4jExecutor };
const statements: { readonly templateId: string; readonly cypher: string }[] = [];

const source = (): SourceModel => sourceFor(server, { entities: ENTITIES, relationships: RELATIONSHIPS });

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, "CREATE (:Item {sid: 'I-1', ref: 'x'}), (:Thing {sid: 'T-1'})");
  for (const type of ['COMMON', 'DROPS', 'WRONG', 'PAIR', 'TWIN_A', 'TWIN_B']) await runAdmin(server, `CREATE INDEX ${type.toLowerCase()}_rec FOR ()-[r:${type}]-() ON (r.rec)`);
  await runAdmin(server, 'CREATE INDEX pair_doc FOR ()-[r:PAIR]-() ON (r.doc)');
  await runAdmin(server, 'CREATE INDEX bulk_rec FOR ()-[r:BULK]-() ON (r.rec)');
  await runAdmin(server, 'CREATE INDEX bulk_doc FOR ()-[r:BULK]-() ON (r.doc)');
  await runAdmin(server, 'CREATE TEXT INDEX texted_rec FOR ()-[r:TEXTED]-() ON (r.rec)');
  await runAdmin(server, 'CREATE INDEX item_sid FOR (n:Item) ON (n.sid)');
  await runAdmin(server, 'CREATE INDEX item_ref FOR (n:Item) ON (n.ref)');
  const one = "MATCH (i:Item {sid: 'I-1'}), (t:Thing {sid: 'T-1'})";
  await runAdmin(server, `${one} UNWIND range(1, ${COMMON_MATCHES}) AS k CREATE (i)-[:COMMON {lid: 'CM-' + k, rec: 'common-text'}]->(t)`);
  await runAdmin(server, `${one} UNWIND range(1, 6000) AS k CREATE (i)-[:COMMON {lid: 'CU-' + k, rec: 'unique-' + k}]->(t)`);
  await runAdmin(server, `${one} CREATE (i)-[:TEXTED {lid: 'TX-1', rec: 'text-value'}]->(t)`);
  await runAdmin(server, "CREATE (:Item:Thing {sid: 'drop-1'}), (:Item {ref: 'drop-1'}), (:Thing:Item {sid: 'AMB-END'}), (:Thing {x: 1})");
  await runAdmin(server, `${one} MATCH (nameless:Thing {x: 1}), (amb:Thing {sid: 'AMB-END'}) CREATE (i)-[:DROPS {lid: 'DR-1', rec: 'drop-1'}]->(nameless), (i)-[:DROPS {lid: 'DR-2', rec: 'drop-1'}]->(amb), (i)-[:DROPS {lid: 'DR-3', rec: 'drop-1'}]->(t)`);
  await runAdmin(server, "CREATE (:Other {sid: 'O-1'})");
  await runAdmin(server, `${one} MATCH (o:Other {sid: 'O-1'}) CREATE (t)-[:WRONG {lid: 'WR-1', rec: 'wrong-1'}]->(i), (i)-[:WRONG {lid: 'WR-2', rec: 'wrong-1'}]->(o)`);
  await runAdmin(server, `${one} CREATE (i)-[:PAIR {lid: 'PA-1', rec: 'both-1', doc: 'both-1'}]->(t), (i)-[:TWIN_A {lid: 'SAME', rec: 'twin-1'}]->(t), (i)-[:TWIN_B {lid: 'SAME', rec: 'twin-1'}]->(t)`);
  await runAdmin(server, `${one} UNWIND range(1, ${BULK_MATCHES}) AS k CREATE (i)-[:BULK {rec: 'bulk-text', at: datetime('2026-01-01T00:00:00Z') + duration({minutes: k})}]->(t)`);
  await runAdmin(server, `${one} UNWIND range(1, 3000) AS k CREATE (i)-[:BULK {rec: 'bulk-other-' + k}]->(t)`);
  await runAdmin(server, `${one} CREATE (i)-[:PAIR {lid: 'PA-ODD', rec: 'odd-1', doc: [1, 2]}]->(t), (i)-[:BULK {rec: 'odd-1', doc: point({x: 1, y: 2})}]->(t)`);
  await runAdmin(server, "MATCH (amb:Thing {sid: 'AMB-END'}), (i:Item {sid: 'I-1'}) CREATE (i)-[:BULK {rec: 'amb-bulk'}]->(amb)");
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
  const defaults = communitySeams();
  const executor = createNeo4jExecutor({ sources: [source()], env: envFor(server), logger: { warn: () => undefined } });
  const recording: Neo4jExecutor = { ...executor, execute: (call) => (statements.push({ templateId: call.templateId, cypher: call.cypher }), executor.execute(call)) };
  const assembled = assembleGate({ mapping: { sources: [source()] }, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor: recording, logger: { warn: () => undefined } });
  rig = { gate: assembled.gate, indexes: assembled.indexes, close: () => executor.close() };
  const profiled: TemplateDefinition = {
    ...searchEvidenceTemplate,
    id: PROFILED,
    scope: 'system',
    profile: true,
    cypher: `PROFILE ${searchEvidenceTemplate.cypher}`,
    normalize: (rows, plan = null) => [{ operators: (plan ?? []).map((operator) => operator.name), rows: rows.length }],
  };
  const profilingExecutor = createNeo4jExecutor({ sources: [source()], env: envFor(server), logger: { warn: () => undefined } });
  profiling = {
    executor: profilingExecutor,
    system: assembleGate({ mapping: { sources: [source()] }, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor: profilingExecutor, logger: { warn: () => undefined }, catalog: createTemplateCatalog({ templates: [profiled, searchExactTemplate] }) }).system,
  };
}, 600_000);

afterAll(async () => {
  await runAll([() => profiling?.executor.close(), () => rig?.close(), () => server?.stop()]);
});

const search = (text: string) => createSearchService({ gate: rig.gate, indexes: rig.indexes, mapping: { sources: [source()] }, access: communityAccess({ sources: [source()] }) }).search({ traceId: 'tr-evidence-seek', principal: LOCAL_PRINCIPAL, sourceId: 'graph', text, mask: false });

describe(`the statement of the evidence read, planned on ${NEO4J_SERIES}`, () => {
  const targets = [
    { relationshipType: 'COMMON', from: 'item', to: 'thing', property: 'rec', match: 'value' },
    { relationshipType: 'TEXTED', from: 'item', to: 'thing', property: 'rec', match: 'text' },
  ];
  const operators = async (text: string): Promise<string[]> => {
    const page = await profiling.system.run({ traceId: 'tr-plan', sourceId: 'graph', templateId: PROFILED, params: { text, targets }, limit: 25 });
    const item = page.items[0];
    return item !== undefined && Array.isArray(item['operators']) ? item['operators'].map(String) : [];
  };

  it.each(['unique-77', 'text-value', '9007199254740993', 'a text that is no integer'])('seeks the relationship index of every branch, under a RANGE index and a TEXT-only index, for %s, with no scan', async (text) => {
    const names = await operators(text);
    expect(names.filter((name) => /RelationshipIndexSeek/.test(name)), names.join(' > ')).toHaveLength(targets.length);
    expect(names.some((name) => /RelationshipTypeScan|NodeByLabelScan|AllNodesScan|IndexScan/.test(name)), names.join(' > ')).toBe(false);
  });

  it('reads a value that 3000 relationships carry by its index only, sorted, bounded by those matches and never by a scan, and seeks it on a page after a cursor too', async () => {
    const template = createTemplateCatalog({ templates: [searchEvidenceTemplate] }).find('relationship-evidence');
    if (template === undefined) throw new Error('no template');
    const rendered = renderTemplate(template, template.paramsSchema.parse({ text: 'common-text', targets: [targets[0]] }), allowlistFromMapping(source()), 25);
    const session = server.admin.session({ database: server.database });
    try {
      const result = await session.run(`PROFILE ${rendered.cypher}`, prepareParameters({ ...rendered.parameters, cursor: null }, []));
      expect(result.records).toHaveLength(26);
      const hits = (node: { readonly dbHits: number; readonly children: readonly unknown[] } | undefined): number => (node === undefined ? 0 : node.dbHits + node.children.reduce<number>((sum, child) => sum + (isProfile(child) ? hits(child) : 0), 0));
      const profile = result.summary.profile;
      // a page is sorted by element ID, so each branch reads every match of the value through its index seek, which the transaction timeout bounds; it never scans
      expect(isProfile(profile) ? hits(profile) : Number.POSITIVE_INFINITY).toBeLessThan(COMMON_MATCHES * 6);
      expect(JSON.stringify(profile)).not.toMatch(/RelationshipTypeScan|NodeByLabelScan|AllNodesScan|IndexScan/);
      const ids = result.records.map((record) => String(record.get('r').elementId));
      expect([...ids].sort()).toEqual(ids);
      const after = ids[24] ?? '';
      const next = await session.run(`PROFILE ${rendered.cypher}`, prepareParameters({ ...rendered.parameters, cursor: { after } }, []));
      expect(next.records.every((record) => String(record.get('r').elementId) > after)).toBe(true);
      expect(String(next.records[0]?.get('r').elementId)).toBe(ids[25]);
      expect(JSON.stringify(next.summary.profile)).toContain('RelationshipIndexSeek');
      expect(JSON.stringify(next.summary.profile)).not.toMatch(/RelationshipTypeScan|NodeByLabelScan|AllNodesScan|IndexScan/);
    } finally {
      await session.close();
    }
  });

  it('seeks the relationship index of a row with no stable ID, with and without a cursor, with no scan', async () => {
    const bulk = [{ relationshipType: 'BULK', from: 'item', to: 'thing', property: 'rec', match: 'value' }];
    const template = createTemplateCatalog({ templates: [searchEvidenceTemplate] }).find('relationship-evidence');
    if (template === undefined) throw new Error('no template');
    const rendered = renderTemplate(template, template.paramsSchema.parse({ text: 'bulk-text', targets: bulk }), allowlistFromMapping(source()), 25);
    const session = server.admin.session({ database: server.database });
    try {
      const first = await session.run(`PROFILE ${rendered.cypher}`, prepareParameters({ ...rendered.parameters, cursor: null }, []));
      expect(first.records).toHaveLength(26);
      const after = String(first.records[24]?.get('r').elementId);
      const next = await session.run(`PROFILE ${rendered.cypher}`, prepareParameters({ ...rendered.parameters, cursor: { after } }, []));
      expect(next.records).toHaveLength(BULK_MATCHES - 25);
      for (const profile of [first.summary.profile, next.summary.profile]) {
        expect(JSON.stringify(profile)).toContain('RelationshipIndexSeek');
        expect(JSON.stringify(profile)).not.toMatch(/RelationshipTypeScan|NodeByLabelScan|AllNodesScan|IndexScan/);
      }
    } finally {
      await session.close();
    }
  });

  it('makes one data statement for the group, whatever it holds', async () => {
    const from = statements.length;
    await search('common-text');
    expect(statements.slice(from).filter((statement) => statement.templateId === 'relationship-evidence')).toHaveLength(1);
  });
});

function isProfile(value: unknown): value is { readonly dbHits: number; readonly children: readonly unknown[] } {
  return typeof value === 'object' && value !== null && 'dbHits' in value && typeof value.dbHits === 'number' && 'children' in value && Array.isArray(value.children);
}

describe(`the rows of the evidence group that normalization leaves out, on ${NEO4J_SERIES}`, () => {
  it('leaves out a relationship whose end has no stable ID, resolves an end whose labels fit two entity types as the type its row maps, counts the rows left out with the exact and related pages (where a record with no stable ID is listed), and shows the whole ones', async () => {
    const answer = await search('drop-1');
    expect(storedHits(answer.evidence.hits).map((hit) => hit.supports.stableId)).toEqual(['DR-2', 'DR-3']);
    expect(storedHits(answer.evidence.hits).find((hit) => hit.supports.stableId === 'DR-2')?.supports).toEqual({ sourceId: 'graph', type: 'DROPS', from: 'item', to: 'thing', stableId: 'DR-2' });
    expect(answer.evidence.count).toEqual({ value: 2, quality: 'exact', scope: 'search:evidence' });
    // the exact group resolves its node of two labels as the type its target names, and an evidence end as the type its row maps
    expect(answer.dropped).toEqual({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 2, 'end-not-shown': 1 });
    const listed = (answer.exactUnreferenced?.length ?? 0) + (answer.related.unreferenced?.length ?? 0);
    expect(answer.warnings).toEqual(warningsOf(answer.dropped, listed));
  });

  it('does not match a relationship of the type between entity types the row does not map, and counts nothing for it', async () => {
    const answer = await search('wrong-1');
    expect(answer.evidence.hits).toEqual([]);
    expect(answer.dropped).toEqual({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });
  });
});

describe(`the hits of the evidence group, on ${NEO4J_SERIES}`, () => {
  it('is one hit for a relationship that carries the text in two evidence properties', async () => {
    const answer = await search('both-1');
    expect(answer.evidence.hits).toHaveLength(1);
    expect(storedHits(answer.evidence.hits)[0]?.records).toEqual([{ sourceRecordId: 'both-1' }]);
    expect(answer.evidence.count).toMatchObject({ value: 1 });
  });

  it('is two hits with distinct references for two relationships of different types that share a stable ID text', async () => {
    const answer = await search('twin-1');
    expect(storedHits(answer.evidence.hits).map((hit) => hit.supports)).toEqual([
      { sourceId: 'graph', type: 'TWIN_A', from: 'item', to: 'thing', stableId: 'SAME' },
      { sourceId: 'graph', type: 'TWIN_B', from: 'item', to: 'thing', stableId: 'SAME' },
    ]);
    expect(storedHits(answer.evidence.hits).every((hit) => !hit.supports.stableId.includes('conflicting'))).toBe(true);
  });
});

const more = (text: string, cursor: string) =>
  createSearchService({ gate: rig.gate, indexes: rig.indexes, mapping: { sources: [source()] }, access: communityAccess({ sources: [source()] }) }).more({ traceId: 'tr-evidence-more', principal: LOCAL_PRINCIPAL, sourceId: 'graph', text, group: 'evidence', cursor, mask: false });

describe(`evidence on a relationship row with no stable ID, on ${NEO4J_SERIES}`, () => {
  it('is one aggregate with its members page by page, by element ID as text, none twice, a lower-bound member count while more remain', async () => {
    const answer = await search('bulk-text');
    expect(answer.evidence.disabledRelationshipTypes).toEqual([]);
    const [first] = aggregateHits(answer.evidence.hits);
    expect(first?.aggregate).toEqual({ type: 'BULK', from: { sourceId: 'graph', entityType: 'item', stableId: 'I-1' }, to: { sourceId: 'graph', entityType: 'thing', stableId: 'T-1' } });
    expect(first?.members).toHaveLength(25);
    expect(first?.memberCount).toEqual({ value: 25, quality: 'lowerBound', scope: 'members' });
    expect(first?.members.every((member) => member.records.length === 1 && member.observedAt !== undefined && Object.keys(member).sort().join() === 'observedAt,records')).toBe(true);
    expect(answer.evidence.count).toEqual({ value: 25, quality: 'lowerBound', scope: 'search:evidence' });
    const page = await more('bulk-text', answer.evidence.nextCursor ?? '');
    if (page.group !== 'evidence') throw new Error('not an evidence page');
    const [next] = aggregateHits(page.hits);
    expect(next?.aggregate).toEqual(first?.aggregate);
    expect(next?.members).toHaveLength(BULK_MATCHES - 25);
    // a member has no ID: the thirty are told apart by their times (one minute apart), and each is on one page only, in the order the cursor keeps
    const times = [...(first?.members ?? []), ...(next?.members ?? [])].map((member) => member.observedAt);
    expect(new Set(times).size).toBe(BULK_MATCHES);
    expect([...times].sort()).toEqual(times);
    expect(page.nextCursor).toBeUndefined();
  });

  it('resolves an end whose labels fit two entity types as the type the row maps', async () => {
    const answer = await search('amb-bulk');
    expect(aggregateHits(answer.evidence.hits).map((hit) => hit.aggregate.to)).toEqual([{ sourceId: 'graph', entityType: 'thing', stableId: 'AMB-END' }]);
    expect(answer.dropped['ambiguous-type']).toBe(0);
  });
});

describe(`an evidence value that cannot be read, on ${NEO4J_SERIES}`, () => {
  it('keeps the hit, stored or a member, with the value marked unreadable by its property, and counts it', async () => {
    const answer = await search('odd-1');
    expect(storedHits(answer.evidence.hits).map((hit) => hit.records)).toEqual([[{ sourceRecordId: 'odd-1' }, { property: 'doc', unreadable: true }]]);
    expect(aggregateHits(answer.evidence.hits).map((hit) => hit.members.map((member) => member.records))).toEqual([[[{ sourceRecordId: 'odd-1' }, { property: 'doc', unreadable: true }]]]);
    expect(answer.evidence.count).toEqual({ value: 2, quality: 'exact', scope: 'search:evidence' });
  });
});
