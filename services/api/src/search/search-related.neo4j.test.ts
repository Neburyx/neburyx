import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { assembleGate } from '../gate/assemble.js';
import { createTemplateCatalog, type TemplateDefinition } from '../gate/catalog.js';
import { renderTemplate } from '../gate/render.js';
import { searchExactTemplate } from '../gate/templates/search-exact.js';
import { searchRelatedTemplate } from '../gate/templates/search-related.js';
import type { Gate, IndexReader, SystemRunner } from '../gate/types.js';
import type { SourceModel } from '../mapping/model.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { createNeo4jExecutor, type Neo4jExecutor } from '../sources/executor.js';
import { prepareParameters } from '../sources/parameters.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { communityAccess } from '../testing/source-access.js';
import { ALWAYS_USABLE } from '../testing/usability.js';
import { createSearchService } from './search-service.js';

const PROFILED = 'test-related-profiled';
const COMMON_MATCHES = 3000;
const SMALL_PAGE = 10;
const ENTITIES = [
  { type: 'by_range', label: 'ByRange', stable_id: 'sid', search: ['sid'], reference: ['ref'] },
  { type: 'by_constraint', label: 'ByConstraint', stable_id: 'sid', reference: ['ref'] },
  { type: 'by_text', label: 'ByText', stable_id: 'sid', reference: ['ref'] },
  { type: 'bulk', label: 'Bulk', stable_id: 'sid', reference: ['ref'] },
  { type: 'common', label: 'Common', stable_id: 'sid', reference: ['ref'] },
  { type: 'dropped', label: 'Dropped', stable_id: 'sid', reference: ['ref'] },
  { type: 'slow', label: 'Slow', stable_id: 'sid', reference: ['ref'] },
  { type: 'person', label: 'Person', stable_id: 'sid', reference: ['taxRef', 'ref'], pii: [{ property: 'taxRef', class: 'text' }] },
];
const SMALL_ENTITIES = [{ type: 'small', label: 'Small', stable_id: 'sid', reference: ['ref'] }];

interface Rig {
  readonly gate: Gate;
  readonly indexes: IndexReader;
  readonly close: () => Promise<void>;
}

let server: RunningNeo4j;
let big: Rig;
let small: Rig;
let profiling: { readonly system: SystemRunner; readonly executor: Neo4jExecutor };
const events: AuditEvent[] = [];
const statements: { readonly templateId: string; readonly cypher: string }[] = [];
let reads = 0;

const sourceOf = (entities: readonly object[], overrides: Record<string, unknown> = {}): SourceModel => sourceFor(server, { entities, relationships: [], ...overrides });
const smallSource = () => sourceOf(SMALL_ENTITIES, { budgets: { max_page: SMALL_PAGE, default_page: SMALL_PAGE } });

function rigFor(source: SourceModel): Rig {
  const defaults = communitySeams();
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = {
    policy: defaults.policy,
    coordinator: { acquireRead: async (request) => (reads += 1, defaults.coordinator.acquireRead(request)) },
    audit: { record: (event) => Promise.resolve(void events.push(event)) },
  };
  const executor = createNeo4jExecutor({ sources: [source], env: envFor(server), logger: { warn: () => undefined } });
  const recording: Neo4jExecutor = { ...executor, execute: (call) => (statements.push({ templateId: call.templateId, cypher: call.cypher }), executor.execute(call)) };
  const assembled = assembleGate({ usability: ALWAYS_USABLE, mapping: { sources: [source] }, seams, executor: recording, logger: { warn: () => undefined } });
  return { gate: assembled.gate, indexes: assembled.indexes, close: () => executor.close() };
}

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE INDEX by_range_ref FOR (n:ByRange) ON (n.ref)');
  await runAdmin(server, 'CREATE INDEX by_range_sid FOR (n:ByRange) ON (n.sid)');
  await runAdmin(server, 'CREATE CONSTRAINT by_constraint_ref FOR (n:ByConstraint) REQUIRE n.ref IS UNIQUE');
  await runAdmin(server, 'CREATE TEXT INDEX by_text_ref FOR (n:ByText) ON (n.ref)');
  for (const label of ['Bulk', 'Common', 'Dropped', 'Small', 'Person']) await runAdmin(server, `CREATE INDEX ${label.toLowerCase()}_ref FOR (n:${label}) ON (n.ref)`);
  await runAdmin(server, 'CREATE INDEX person_tax FOR (n:Person) ON (n.taxRef)');
  await runAdmin(server, "CREATE (:ByRange {sid: 'R-1', ref: 'REF-1'}), (:ByRange {sid: 'R-2', ref: 7}), (:ByRange {sid: 'R-3', ref: '007'}), (:ByRange {sid: 'REF-1', ref: 'other'})");
  await runAdmin(server, "CREATE (:ByConstraint {sid: 'K-1', ref: 'REF-1'}), (:ByConstraint {sid: 'K-2', ref: 123}), (:ByConstraint {sid: 'K-3', ref: '123'})");
  await runAdmin(server, "CREATE (:ByText {sid: 'T-1', ref: '123'}), (:ByText {sid: 'T-2', ref: 456}), (:ByText {sid: 'T-3', ref: 'REF-1'})");
  for (const size of [24, 25, 26]) await runAdmin(server, `UNWIND range(1, ${size}) AS i CREATE (:Bulk {sid: 'B-${size}-' + i, ref: 'bulk-${size}'})`);
  for (const size of [SMALL_PAGE, SMALL_PAGE + 1]) await runAdmin(server, `UNWIND range(1, ${size}) AS i CREATE (:Small {sid: 'S-${size}-' + i, ref: 'small-${size}'})`);
  await runAdmin(server, `UNWIND range(1, ${COMMON_MATCHES}) AS i CREATE (:Common {sid: 'C-' + i, ref: 'common-text'})`);
  await runAdmin(server, "CREATE (:Dropped {sid: 'D-1', ref: 'drop-me'}), (:Person {sid: 'P-1', taxRef: 'TAX-1', ref: 'person-ref'}), (:Person {sid: 'P-2', taxRef: 'other', ref: 'TAX-1'})");
  await runAdmin(server, "CREATE (:ByRange {ref: 'drop-1'}), (:ByRange:ByText {sid: 'AMB-1', ref: 'drop-1'}), (:ByRange {sid: 'OK-1', ref: 'drop-1'})");
  await runAdmin(server, "UNWIND range(1, 30) AS i CREATE (n:ByRange {ref: 'cap-drop'}) SET n.sid = CASE WHEN i % 10 = 0 THEN null ELSE 'CD-' + i END");
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
  big = rigFor(sourceOf(ENTITIES));
  small = rigFor(smallSource());
  const profiled: TemplateDefinition = {
    ...searchRelatedTemplate,
    id: PROFILED,
    scope: 'system',
    profile: true,
    cypher: `PROFILE ${searchRelatedTemplate.cypher}`,
    normalize: (rows, plan = null) => [{ operators: (plan ?? []).map((operator) => operator.name), rows: rows.length }],
  };
  const executor = createNeo4jExecutor({ sources: [sourceOf(ENTITIES)], env: envFor(server), logger: { warn: () => undefined } });
  const defaults = communitySeams();
  profiling = {
    executor,
    system: assembleGate({ usability: ALWAYS_USABLE, mapping: { sources: [sourceOf(ENTITIES)] }, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger: { warn: () => undefined }, catalog: createTemplateCatalog({ templates: [profiled, searchExactTemplate] }) }).system,
  };
}, 600_000);

afterAll(async () => {
  await runAll([() => profiling?.executor.close(), () => big?.close(), () => small?.close(), () => server?.stop()]);
});

const service = (rig: Rig, source: SourceModel) => createSearchService({ gate: rig.gate, indexes: rig.indexes, mapping: { sources: [source] }, access: communityAccess({ sources: [source] }) });
const search = (text: string, mask = false) => service(big, sourceOf(ENTITIES)).search({ traceId: 'tr-related', principal: LOCAL_PRINCIPAL, sourceId: 'graph', text, mask });
const relatedIds = async (text: string, entityType?: string): Promise<string[]> => (await search(text)).related.hits.filter((hit) => entityType === undefined || hit.node.ref.entityType === entityType).map((hit) => hit.node.ref.stableId);
const relatedStatements = (from = 0) => statements.slice(from).filter((statement) => statement.templateId === 'entity-related');
const naming = (label: string, from = 0): number => relatedStatements(from).filter((statement) => statement.cypher.includes(`\`${label}\``)).length;

describe(`the related records of a search on ${NEO4J_SERIES}`, () => {
  it('finds the records that hold the typed text in a reference property, under a plain RANGE index, a constraint and a TEXT index only, and names the property', async () => {
    const answer = await search('REF-1');
    const found = answer.related.hits.map((hit) => `${hit.node.ref.entityType}/${hit.node.ref.stableId}`).sort();
    expect(found).toEqual(['by_constraint/K-1', 'by_range/R-1', 'by_text/T-3']);
    expect(answer.related.hits.every((hit) => hit.matchedProperties.join() === 'ref')).toBe(true);
    expect(answer.exact.map((node) => node.ref.stableId)).toEqual(['REF-1']);
    expect(answer.counts.exact).toMatchObject({ value: 1, quality: 'exact' });
    expect(answer.related.count).toMatchObject({ value: 3, quality: 'exact', scope: 'search:related' });
  });

  it('finds nothing for an ID no record references', async () => {
    const answer = await search('nobody-references-this');
    expect(answer.related.hits).toEqual([]);
    expect(answer.related.count).toMatchObject({ value: 0, quality: 'exact' });
    expect(answer.related.searchable).toBe(true);
  });

  it('finds an integer reference value through a RANGE index and a constraint, and not through a TEXT-only index, which holds no integers', async () => {
    expect(await relatedIds('7', 'by_range')).toEqual(['R-2']);
    expect(await relatedIds('123', 'by_constraint')).toEqual(['K-2', 'K-3']);
    expect(await relatedIds('123', 'by_text')).toEqual(['T-1']);
    expect(await relatedIds('456', 'by_text')).toEqual([]);
    expect(await relatedIds('007', 'by_range')).toEqual(['R-3']);
    expect(await relatedIds('+7')).toEqual([]);
  });

  it('lists a record that is both an exact match and a referencing record in both groups, counted in each', async () => {
    await runAdmin(server, "CREATE (:ByRange {sid: 'BOTH-1', ref: 'BOTH-1'})");
    const answer = await search('BOTH-1');
    expect(answer.exact.map((node) => node.ref.stableId)).toEqual(['BOTH-1']);
    expect(answer.related.hits.map((hit) => hit.node.ref.stableId)).toEqual(['BOTH-1']);
    expect(answer.counts.exact).toEqual({ value: 1, quality: 'exact', scope: 'search:exact' });
    expect(answer.related.count).toEqual({ value: 1, quality: 'exact', scope: 'search:related' });
    await runAdmin(server, "MATCH (n:ByRange {sid: 'BOTH-1'}) DELETE n");
  });
});

describe(`the cap and the count of the related group on ${NEO4J_SERIES}`, () => {
  it.each([
    [24, 24, 'exact'],
    [25, 25, 'exact'],
    [26, 25, 'lowerBound'],
  ])('shows %i referencing records as %i hits and an %s count', async (records, hits, quality) => {
    const answer = await search(`bulk-${records}`);
    expect(answer.related.hits).toHaveLength(hits);
    expect(answer.related.count).toMatchObject({ value: hits, quality });
    expect(answer.cap).toBe(25);
  });

  it.each([
    [SMALL_PAGE, SMALL_PAGE, 'exact'],
    [SMALL_PAGE + 1, SMALL_PAGE, 'lowerBound'],
  ])('shows %i referencing records as %i hits and an %s count for a source whose max_page is 10', async (records, hits, quality) => {
    const answer = await service(small, smallSource()).search({ traceId: 'tr-small', principal: LOCAL_PRINCIPAL, sourceId: 'graph', text: `small-${records}`, mask: false });
    expect(answer.related.hits).toHaveLength(hits);
    expect(answer.related.count).toMatchObject({ value: hits, quality });
    expect(answer.cap).toBe(SMALL_PAGE);
  });

  it('shows 3000 referencing records as 25 and a lower bound of 25', async () => {
    const answer = await search('common-text');
    expect(answer.related.hits).toHaveLength(25);
    expect(answer.related.count).toMatchObject({ value: 25, quality: 'lowerBound' });
  });
});

describe(`the rows of the related group that normalization leaves out, on ${NEO4J_SERIES}`, () => {
  it('leaves out a record with no stable ID and one whose labels fit two entity types, counts them by reason, and shows the record that is whole', async () => {
    const answer = await search('drop-1');
    expect(answer.related.hits.map((hit) => hit.node.ref.stableId)).toEqual(['OK-1']);
    expect(answer.related.count).toMatchObject({ value: 1, quality: 'exact' });
    expect(answer.dropped).toEqual({ 'not-mapped': 0, 'ambiguous-type': 1, 'no-stable-id': 1 });
    expect(answer.warnings).toHaveLength(2);
  });

  it('holds the hits it has, as a lower bound, when a capped read had rows left out', async () => {
    const answer = await search('cap-drop');
    const shown = answer.related.hits.length + answer.dropped['no-stable-id'];
    expect(shown).toBe(25);
    expect(answer.dropped['no-stable-id']).toBeGreaterThan(0);
    expect(answer.related.count).toEqual({ value: answer.related.hits.length, quality: 'lowerBound', scope: 'search:related' });
    expect(answer.related.hits.length).toBeLessThan(25);
  });
});

describe(`the statement of the related read, planned on ${NEO4J_SERIES}`, () => {
  const targets = [
    { entityType: 'by_range', property: 'ref', match: 'value' },
    { entityType: 'by_constraint', property: 'ref', match: 'value' },
    { entityType: 'by_text', property: 'ref', match: 'text' },
  ];
  const operators = async (text: string, aTargets: readonly object[] = targets): Promise<string[]> => {
    const page = await profiling.system.run({ traceId: 'tr-plan', sourceId: 'graph', templateId: PROFILED, params: { text, targets: aTargets }, limit: 25 });
    const item = page.items[0];
    return item !== undefined && Array.isArray(item['operators']) ? item['operators'].map(String) : [];
  };

  it.each(['REF-1', '123', '9007199254740993', 'a text that is no integer'])('seeks the index of every branch, under a RANGE index, a constraint and a TEXT-only index, for %s, with no scan and no filter', async (text) => {
    const names = await operators(text);
    expect(names.filter((name) => /IndexSeek/.test(name)), names.join(' > ')).toHaveLength(targets.length);
    expect(names.some((name) => /NodeByLabelScan|AllNodesScan|NodeIndexScan|^Filter/.test(name)), names.join(' > ')).toBe(false);
  });

  it('cuts a branch at its own limit: a value that 3000 records carry reads fewer than a third of them', async () => {
    const template = createTemplateCatalog({ templates: [searchRelatedTemplate] }).find('entity-related');
    if (template === undefined) throw new Error('no template');
    const rendered = renderTemplate(template, template.paramsSchema.parse({ text: 'common-text', targets: [{ entityType: 'common', property: 'ref', match: 'value' }] }), allowlistFromMapping(sourceOf(ENTITIES)), 25);
    const session = server.admin.session({ database: server.database });
    try {
      const result = await session.run(`PROFILE ${rendered.cypher}`, prepareParameters(rendered.parameters, []));
      expect(result.records).toHaveLength(26);
      const hits = (node: { readonly dbHits: number; readonly children: readonly unknown[] } | undefined): number => (node === undefined ? 0 : node.dbHits + node.children.reduce<number>((sum, child) => sum + (isProfile(child) ? hits(child) : 0), 0));
      const profile = result.summary.profile;
      expect(isProfile(profile) ? hits(profile) : Number.POSITIVE_INFINITY).toBeLessThan(COMMON_MATCHES / 3);
    } finally {
      await session.close();
    }
  });

  it('would scan the label if the index were gone and nothing guarded the read: the guard below is what keeps the search from it', async () => {
    await runAdmin(server, 'DROP INDEX dropped_ref');
    const names = await operators('drop-me', [{ entityType: 'dropped', property: 'ref', match: 'value' }]);
    expect(names.some((name) => /NodeByLabelScan|AllNodesScan/.test(name)), names.join(' > ')).toBe(true);
    await runAdmin(server, 'CREATE INDEX dropped_ref FOR (n:Dropped) ON (n.ref)');
    await runAdmin(server, 'CALL db.awaitIndexes(120)');
  });
});

function isProfile(value: unknown): value is { readonly dbHits: number; readonly children: readonly unknown[] } {
  return typeof value === 'object' && value !== null && 'dbHits' in value && typeof value.dbHits === 'number' && 'children' in value && Array.isArray(value.children);
}

describe(`a reference index that is gone since the check, on ${NEO4J_SERIES}`, () => {
  it('is left out of the next search with its message, and no statement of the related read names the label, so no label scan can have run', async () => {
    expect(await relatedIds('drop-me', 'dropped')).toEqual(['D-1']);
    await runAdmin(server, 'DROP INDEX dropped_ref');
    const from = statements.length;
    const answer = await search('drop-me');
    expect(answer.related.disabledTypes.map((disabled) => disabled.entityType)).toContain('dropped');
    expect(answer.related.disabledTypes.every((disabled) => disabled.reason === 'index-unavailable')).toBe(true);
    expect(answer.related.hits.filter((hit) => hit.node.ref.entityType === 'dropped')).toEqual([]);
    expect(naming('Dropped', from)).toBe(0);
    await runAdmin(server, 'CREATE INDEX dropped_ref FOR (n:Dropped) ON (n.ref)');
    await runAdmin(server, 'CALL db.awaitIndexes(120)');
    expect(await relatedIds('drop-me', 'dropped')).toEqual(['D-1']);
  });

  it('is left out while it is being built, and read again when it is online', async () => {
    await runAdmin(server, 'UNWIND range(1, 200000) AS i CREATE (:Slow {sid: toString(i), ref: toString(i)})');
    await runAdmin(server, 'CREATE INDEX slow_ref FOR (n:Slow) ON (n.ref)');
    const from = statements.length;
    const during = await search('77');
    const stillBuilding = during.related.disabledTypes.some((disabled) => disabled.entityType === 'slow');
    if (stillBuilding) expect(naming('Slow', from)).toBe(0);
    expect(stillBuilding, 'the index of 200,000 nodes was online before the search ran').toBe(true);
    await runAdmin(server, 'CALL db.awaitIndexes(300)');
    expect(await relatedIds('77', 'slow')).toEqual(['77']);
  }, 300_000);
});

describe(`masking in the related group on ${NEO4J_SERIES}`, () => {
  it('leaves a personal-data reference property out of a masked search, finds the record through its other property, names only that one and masks the value of the first', async () => {
    const plain = await search('TAX-1');
    expect(plain.related.hits.map((hit) => [hit.node.ref.stableId, hit.matchedProperties])).toEqual([
      ['P-1', ['taxRef']],
      ['P-2', ['ref']],
    ]);
    const masked = await search('TAX-1', true);
    expect(masked.related.hits.map((hit) => [hit.node.ref.stableId, hit.matchedProperties])).toEqual([['P-2', ['ref']]]);
    expect(JSON.stringify(masked)).not.toContain('other');
    const first = (await search('person-ref', true)).related.hits[0];
    expect(first?.node.properties.find((property) => property.key === 'taxRef')).toMatchObject({ masked: true, maskedBy: 'request' });
    expect(JSON.stringify(first)).not.toContain('TAX-1');
  });
});

describe(`the reads of a search counted through the seam, on ${NEO4J_SERIES}`, () => {
  it('costs one read for each group, one for the facets and one for the schema, and records one audit event for each group and for the facets', async () => {
    reads = 0;
    events.length = 0;
    const from = statements.length;
    await search('REF-1');
    expect(reads).toBe(4);
    expect(statements.slice(from).map((statement) => statement.templateId).sort()).toEqual(['entity-related', 'entity-search', 'schema-indexes', 'search-facets']);
    expect(events.filter((event) => event.action.startsWith('entity.search')).map((event) => `${event.action} ${event.result}`).sort()).toEqual(['entity.search success', 'entity.search_facets success', 'entity.search_related success']);
  });
});
