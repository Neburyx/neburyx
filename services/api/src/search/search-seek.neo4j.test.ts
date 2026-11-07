import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { createEntityReader } from '../entities/entity-reader.js';
import { assembleGate } from '../gate/assemble.js';
import { createTemplateCatalog, type TemplateDefinition } from '../gate/catalog.js';
import { renderTemplate } from '../gate/render.js';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { searchExactTemplate } from '../gate/templates/search-exact.js';
import type { Gate, IndexReader, SystemRunner } from '../gate/types.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { createNeo4jExecutor, type Neo4jExecutor } from '../sources/executor.js';
import { prepareParameters } from '../sources/parameters.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { communityAccess } from '../testing/source-access.js';
import { createSearchService } from './search-service.js';

const PROFILED = 'test-search-profiled';
const COMMON_MATCHES = 3000;
const ENTITIES = [
  { type: 'held_by_constraint', label: 'HeldByConstraint', stable_id: 'itemId', search: ['itemId'] },
  { type: 'held_by_index', label: 'HeldByIndex', stable_id: 'itemId', search: ['itemId'] },
  { type: 'held_by_text', label: 'HeldByText', stable_id: 'textId', search: ['code'] },
  { type: 'bulk', label: 'Bulk', stable_id: 'bulkId', search: ['code', 'alt'] },
  { type: 'common', label: 'Common', stable_id: 'commonId', search: ['code', 'alt'] },
  { type: 'slow', label: 'Slow', stable_id: 'slowId', search: ['code'] },
];
/** An entity type whose name holds a quote, a backslash, a line break and a character beyond the basic plane: names Cypher text could not hold as they are. */
const ODD_TYPE = "it's \\ a\nb 😀";
const ODD_ENTITY = { type: ODD_TYPE, label: 'OddName', stable_id: 'oddId', search: ['oddCode'] };

let server: RunningNeo4j;
let gate: Gate;
let indexes: IndexReader;
let closing: () => Promise<void>;
let profiling: { readonly system: SystemRunner; readonly executor: Neo4jExecutor };
const events: AuditEvent[] = [];
const statements: string[] = [];

const source = () => sourceFor(server, { entities: [...ENTITIES, ODD_ENTITY], relationships: [] });

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT held_unique FOR (n:HeldByConstraint) REQUIRE n.itemId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX held_plain FOR (n:HeldByIndex) ON (n.itemId)');
  await runAdmin(server, 'CREATE TEXT INDEX held_text FOR (n:HeldByText) ON (n.code)');
  await runAdmin(server, 'CREATE INDEX bulk_code FOR (n:Bulk) ON (n.code)');
  await runAdmin(server, 'CREATE INDEX bulk_alt FOR (n:Bulk) ON (n.alt)');
  await runAdmin(server, 'CREATE INDEX common_code FOR (n:Common) ON (n.code)');
  await runAdmin(server, 'CREATE INDEX common_alt FOR (n:Common) ON (n.alt)');
  await runAdmin(server, 'UNWIND [123, 9007199254740993, -42, 9223372036854775807, -9223372036854775808] AS v CREATE (:HeldByConstraint {itemId: v}), (:HeldByIndex {itemId: v})');
  await runAdmin(server, "CREATE (:HeldByIndex {itemId: '123'}), (:HeldByIndex {itemId: '007'}), (:HeldByConstraint {itemId: '007'}), (:HeldByIndex {itemId: 7}), (:HeldByIndex {itemId: 5}), (:HeldByIndex {itemId: 0}), (:HeldByIndex {itemId: 1000}), (:HeldByIndex {itemId: 1})");
  await runAdmin(server, "CREATE (:HeldByText {textId: 't1', code: '123'}), (:HeldByText {textId: 't2', code: 456}), (:HeldByText {textId: 't3', code: 'AC-1'})");
  for (const size of [24, 25, 26]) await runAdmin(server, `UNWIND range(1, ${size}) AS i CREATE (:Bulk {bulkId: 'B-${size}-' + i, code: 'bulk-${size}'})`);
  await runAdmin(server, "CREATE (:Bulk {bulkId: 'B-DUAL', code: 'dual', alt: 'dual'}), (:Bulk {bulkId: 'B-AC', code: 'AC-1'})");
  await runAdmin(server, "UNWIND range(1, 60) AS i CREATE (:Bulk {bulkId: 'P61-' + i, code: CASE WHEN i % 2 = 0 THEN 'page-61' ELSE 'other' END, alt: CASE WHEN i % 2 = 0 THEN 'other' ELSE 'page-61' END})");
  await runAdmin(server, "CREATE (:Bulk {bulkId: 'P61-both', code: 'page-61', alt: 'page-61'})");
  await runAdmin(server, `UNWIND range(1, ${COMMON_MATCHES}) AS i CREATE (:Common {commonId: 'C-' + i, code: 'common-text', alt: 'common-text'})`);
  await runAdmin(server, 'CREATE INDEX odd_code FOR (n:OddName) ON (n.oddCode)');
  await runAdmin(server, "CREATE (:OddName {oddId: 'O-1', oddCode: 'odd-code'}), (:Bulk {bulkId: 'B-ODD', code: 'odd-code'})");
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
  const mapping = { sources: [source()] };
  const defaults = communitySeams();
  const seams = { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: (event: AuditEvent) => Promise.resolve(void events.push(event)) } };
  const executor = createNeo4jExecutor({ sources: mapping.sources, env: envFor(server), logger: { warn: () => undefined } });
  const recording: Neo4jExecutor = { ...executor, execute: (call) => (statements.push(call.cypher), executor.execute(call)) };
  const assembled = assembleGate({ mapping, seams, executor: recording, logger: { warn: () => undefined } });
  gate = assembled.gate;
  indexes = assembled.indexes;
  closing = () => executor.close();
  const profiled: TemplateDefinition = { ...searchExactTemplate, id: PROFILED, scope: 'system', profile: true, cypher: `PROFILE ${searchExactTemplate.cypher}`, normalize: (rows, plan = null) => [{ operators: (plan ?? []).map((operator) => `${operator.name} ${operator.details ?? ''}`), rows: rows.length }] };
  const profilingExecutor = createNeo4jExecutor({ sources: mapping.sources, env: envFor(server), logger: { warn: () => undefined } });
  profiling = { system: assembleGate({ mapping, seams, executor: profilingExecutor, logger: { warn: () => undefined }, catalog: createTemplateCatalog({ templates: [profiled] }) }).system, executor: profilingExecutor };
}, 600_000);

afterAll(async () => {
  await runAll([() => profiling?.executor.close(), () => closing?.(), () => server?.stop()]);
});

const service = () => createSearchService({ gate, indexes, mapping: { sources: [source()] }, access: communityAccess({ sources: [source()] }) });
const search = (text: string, mask = false) => service().search({ traceId: 'tr-search-seek', principal: LOCAL_PRINCIPAL, sourceId: 'graph', text, mask });
const stableIds = async (text: string, entityType?: string): Promise<string[]> => (await search(text)).exact.filter((node) => entityType === undefined || node.ref.entityType === entityType).map((node) => node.ref.stableId);
const namingLabel = (label: string, from = 0): number => statements.slice(from).filter((statement) => statement.includes(`\`${label}\``)).length;

describe(`the search of integers and text on ${NEO4J_SERIES}`, () => {
  it('finds an entity whose ID is an integer and one that holds the same digits as text, under a constraint and under a plain index; the two nodes of one reference are one hit that says they conflict', async () => {
    expect(await stableIds('123', 'held_by_constraint')).toEqual(['123']);
    const hits = (await search('123')).exact.filter((node) => node.ref.entityType === 'held_by_index');
    expect(hits.map((node) => node.ref.stableId)).toEqual(['123']);
    expect(hits[0]?.qualityFlags).toContain('conflicting-duplicate');
  });

  it.each(['9007199254740993', '9223372036854775807', '-9223372036854775808', '-42'])('finds the integer %s exactly, above the safe range and at both ends of 64 bits', async (text) => {
    for (const type of ['held_by_constraint', 'held_by_index']) expect(await stableIds(text, type)).toEqual([text]);
  });

  it.each([
    ['007', ['007']],
    ['+5', []],
    ['-0', []],
    ['1e3', []],
    ['1.0', []],
    ['9223372036854775808', []],
    ['-9223372036854775809', []],
  ])('matches the text %s as text only: it finds %j and never the integer it resembles', async (text, found) => {
    expect([...new Set(await stableIds(text))]).toEqual(found);
  });

  it('finds the text value of a property that has a TEXT index only, as text, and not an integer value with the same digits, which a TEXT index does not hold', async () => {
    expect(await stableIds('123', 'held_by_text')).toEqual(['t1']);
    expect(await stableIds('456', 'held_by_text')).toEqual([]);
    expect(await stableIds('AC-1', 'held_by_text')).toEqual(['t3']);
  });
});

describe(`the statement of the search, planned on ${NEO4J_SERIES}`, () => {
  const targets = [
    { entityType: 'held_by_constraint', property: 'itemId', match: 'value' },
    { entityType: 'held_by_index', property: 'itemId', match: 'value' },
    { entityType: 'held_by_text', property: 'code', match: 'text' },
    { entityType: 'bulk', property: 'code', match: 'value' },
    { entityType: 'bulk', property: 'alt', match: 'value' },
  ];
  const operators = async (text: string): Promise<string[]> => {
    const page = await profiling.system.run({ traceId: 'tr-plan', sourceId: 'graph', templateId: PROFILED, params: { text, targets }, limit: 25 });
    const item = page.items[0];
    return item !== undefined && Array.isArray(item['operators']) ? item['operators'].map(String) : [];
  };

  it.each(['123', 'AC-1', '9007199254740993', 'a text that is no integer'])('seeks the index of every branch, under a constraint, a plain RANGE index and a TEXT-only index, for %s, with no scan and no filter but the cursor of the page', async (text) => {
    const names = await operators(text);
    expect(names.filter((name) => /IndexSeek/.test(name)), names.join(' > ')).toHaveLength(targets.length);
    expect(names.some((name) => /NodeByLabelScan|AllNodesScan|NodeIndexScan/.test(name)), names.join(' > ')).toBe(false);
    // the one filter of a branch is the keyset of the page, on the element ID of a node the seek found
    expect(names.filter((name) => /^Filter/.test(name)).every((name) => name.includes('elementId') && name.includes('$cursor')), names.join(' > ')).toBe(true);
  });

  it('seeks the index on a page after a cursor too, and returns the rows after it only, in element ID order', async () => {
    const template = createTemplateCatalog({ templates: [searchExactTemplate] }).find('entity-search');
    if (template === undefined) throw new Error('no template');
    const rendered = renderTemplate(template, template.paramsSchema.parse({ text: 'bulk-26', targets: [{ entityType: 'bulk', property: 'code', match: 'value' }, { entityType: 'bulk', property: 'alt', match: 'value' }] }), allowlistFromMapping(source()), 10);
    const session = server.admin.session({ database: server.database });
    try {
      const first = await session.run(`PROFILE ${rendered.cypher}`, prepareParameters({ ...rendered.parameters, cursor: null }, []));
      const ids = first.records.map((record) => String(record.get('n').elementId));
      expect(ids).toHaveLength(11);
      expect([...ids].sort()).toEqual(ids);
      const after = ids[9] ?? '';
      const second = await session.run(`PROFILE ${rendered.cypher}`, prepareParameters({ ...rendered.parameters, cursor: { after } }, []));
      const next = second.records.map((record) => String(record.get('n').elementId));
      expect(next).toHaveLength(11);
      expect(next.every((id) => id > after)).toBe(true);
      expect(next[0]).toBe(ids[10]);
      const operators = operatorsOf(second.summary.profile);
      expect(operators.filter((name) => /IndexSeek/.test(name)), operators.join(' > ')).toHaveLength(2);
      expect(operators.some((name) => /NodeByLabelScan|AllNodesScan|NodeIndexScan/.test(name)), operators.join(' > ')).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('reads the matches of a value that thousands of entities carry by the index only, sorted, and bounded by those matches and not by the label', async () => {
    const template = createTemplateCatalog({ templates: [searchExactTemplate] }).find('entity-search');
    if (template === undefined) throw new Error('no template');
    const rendered = renderTemplate(
      template,
      template.paramsSchema.parse({ text: 'common-text', targets: [{ entityType: 'common', property: 'code', match: 'value' }, { entityType: 'common', property: 'alt', match: 'value' }] }),
      allowlistFromMapping(source()),
      25,
    );
    const session = server.admin.session({ database: server.database });
    try {
      const result = await session.run(`PROFILE ${rendered.cypher}`, prepareParameters({ ...rendered.parameters, cursor: null }, []));
      expect(result.records).toHaveLength(26);
      const hits = (node: { readonly dbHits: number; readonly children: readonly unknown[] } | undefined): number => (node === undefined ? 0 : node.dbHits + node.children.reduce<number>((sum, child) => sum + (isProfile(child) ? hits(child) : 0), 0));
      const profile = result.summary.profile;
      // a page is sorted by element ID, so each branch reads every match of the value (one stored value) through its index seek, which the transaction timeout bounds; it never scans the label
      const total = isProfile(profile) ? hits(profile) : Number.POSITIVE_INFINITY;
      expect(total).toBeLessThan(COMMON_MATCHES * 2 * 4);
      expect(operatorsOf(profile).some((name) => /NodeByLabelScan|AllNodesScan|NodeIndexScan/.test(name))).toBe(false);
    } finally {
      await session.close();
    }
  });
});

function operatorsOf(node: unknown): string[] {
  if (typeof node !== 'object' || node === null || !('operatorType' in node) || !('children' in node) || !Array.isArray(node.children)) return [];
  return [String(node.operatorType), ...node.children.flatMap(operatorsOf)];
}

function isProfile(value: unknown): value is { readonly dbHits: number; readonly children: readonly unknown[] } {
  return typeof value === 'object' && value !== null && 'dbHits' in value && typeof value.dbHits === 'number' && 'children' in value && Array.isArray(value.children);
}

describe(`the cap and the count of a search on ${NEO4J_SERIES}`, () => {
  it.each([
    [24, 24, 'exact'],
    [25, 25, 'exact'],
    [26, 25, 'lowerBound'],
  ])('shows %i matching entities as %i hits and an %s count', async (matches, shown, quality) => {
    const result = await search(`bulk-${matches}`);
    expect(result.exact).toHaveLength(shown);
    expect(result.counts.exact).toMatchObject({ value: shown, quality });
    expect(result.cap).toBe(25);
  });

  it('shows 3000 matching entities as 25 and a lower bound of 25', async () => {
    const result = await search('common-text');
    expect(result.exact).toHaveLength(25);
    expect(result.counts.exact).toMatchObject({ value: 25, quality: 'lowerBound' });
  });

  it('shows an entity that matches through two properties once, and counts it once', async () => {
    events.length = 0;
    const result = await search('dual');
    expect(result.exact.map((node) => node.ref.stableId)).toEqual(['B-DUAL']);
    expect(result.counts.exact).toMatchObject({ value: 1, quality: 'exact' });
    expect(events.filter((event) => event.action === 'entity.search')).toEqual([expect.objectContaining({ result: 'success' })]);
  });

  it('runs the statement for an entity type whose name holds a quote, a backslash, a line break and an emoji, and names the hit by that type exactly', async () => {
    const from = statements.length;
    const result = await search('odd-code');
    expect(result.exact.map((node) => [node.ref.entityType, node.ref.stableId])).toEqual([
      ['bulk', 'B-ODD'],
      [ODD_TYPE, 'O-1'],
    ]);
    expect(result.exact.find((node) => node.ref.stableId === 'O-1')?.ref.entityType).toBe(ODD_TYPE);
    expect(statements.slice(from).some((statement) => statement.includes("it's") || statement.includes('😀'))).toBe(false);
  });

  it('finds an entity by its whole value only: case, a prefix, a trailing space and a longer value find nothing', async () => {
    expect(await stableIds('AC-1', 'bulk')).toEqual(['B-AC']);
    for (const text of ['ac-1', 'AC-', 'AC-1 ', 'AC-10', 'ac-1 ']) expect(await stableIds(text), text).toEqual([]);
  });
});

describe(`the pages of a group on ${NEO4J_SERIES}`, () => {
  it('reaches all 61 matches over three pages through the gate, each once and none skipped, a node of two matching properties on one page only', async () => {
    const first = await search('page-61');
    expect(first.counts.exact).toMatchObject({ value: 25, quality: 'lowerBound' });
    const more = (cursor: string | undefined) => service().more({ traceId: 'tr-search-pages', principal: LOCAL_PRINCIPAL, sourceId: 'graph', text: 'page-61', mask: false, group: 'exact', cursor: cursor ?? '' });
    const second = await more(first.exactNextCursor);
    const third = await more(second.nextCursor);
    const ids = (page: typeof second) => (page.group === 'exact' ? page.nodes.map((node) => node.ref.stableId) : []);
    expect([first.exact.length, ids(second).length, ids(third).length]).toEqual([25, 25, 11]);
    expect(second).toMatchObject({ count: { value: 50, quality: 'lowerBound' } });
    expect(third).toMatchObject({ count: { value: 61, quality: 'exact' } });
    expect(third.nextCursor).toBeUndefined();
    const all = [...first.exact.map((node) => node.ref.stableId), ...ids(second), ...ids(third)];
    expect(new Set(all).size).toBe(61);
    expect(all.filter((id) => id === 'P61-both')).toHaveLength(1);
  });

  it('refuses the cursor of one text for another as CURSOR_INVALIDATED', async () => {
    const first = await search('page-61');
    const failure = await service()
      .more({ traceId: 'tr-search-pages', principal: LOCAL_PRINCIPAL, sourceId: 'graph', text: 'common-text', mask: false, group: 'exact', cursor: first.exactNextCursor ?? '' })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'CURSOR_INVALIDATED' });
  });
});

describe(`the schema read at the start of each search on ${NEO4J_SERIES}`, () => {
  it('is quick: the median of 20 reads, with the indexes of this database', async () => {
    const times: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      const snapshot = await indexes.read({ traceId: 'tr-timing', principal: LOCAL_PRINCIPAL, sourceId: 'graph' });
      times.push(performance.now() - started);
      expect(snapshot === 'unverified' ? 0 : snapshot.entries.length).toBeGreaterThan(0);
    }
    times.sort((a, b) => a - b);
    expect(times[10] ?? Number.POSITIVE_INFINITY).toBeLessThan(500);
  });
});

describe(`an index that is gone since the check, on ${NEO4J_SERIES}`, () => {
  it('leaves the property out of the next search with its reason, searches the type by its other property, and no statement names the property, so no label scan can have run', async () => {
    expect(await stableIds('bulk-24', 'bulk')).toHaveLength(24);
    await runAdmin(server, 'DROP INDEX bulk_code');
    const from = statements.length;
    const result = await search('bulk-24');
    expect(result.disabledTypes).toEqual([
      { entityType: 'bulk', property: 'code', reason: 'index-unavailable', typeSearched: true },
      { entityType: 'slow', property: 'code', reason: 'index-unavailable', typeSearched: false },
    ]);
    expect(result.exact.filter((node) => node.ref.entityType === 'bulk')).toEqual([]);
    expect(statements.slice(from).filter((statement) => statement.includes('MATCH (n:`Bulk`) WHERE n.`code`'))).toEqual([]);
    expect(statements.slice(from).filter((statement) => statement.includes('MATCH (n:`Bulk`) WHERE n.`alt`')).length).toBeGreaterThan(0);
    // the exact read and the facet read each name the label that still has its index
    expect(namingLabel('HeldByIndex', from)).toBe(2);
    await runAdmin(server, 'CREATE INDEX bulk_code FOR (n:Bulk) ON (n.code)');
    await runAdmin(server, 'CALL db.awaitIndexes(120)');
    expect(await stableIds('bulk-24', 'bulk')).toHaveLength(24);
  });

  it('is left out of the search while it is being built, and searched again when it is online', async () => {
    await runAdmin(server, 'UNWIND range(1, 200000) AS i CREATE (:Slow {slowId: toString(i), code: toString(i)})');
    await runAdmin(server, 'CREATE INDEX slow_code FOR (n:Slow) ON (n.code)');
    const from = statements.length;
    // a search written by hand for the building index, sent first: an index only goes from building to online, so when the search after it still finds it building, so did this one
    const handWritten = await gate
      .run({ traceId: 'tr-building', principal: LOCAL_PRINCIPAL, sourceId: 'graph', templateId: searchExactTemplate.id, params: { text: '77', targets: [{ entityType: 'slow', property: 'code', match: 'value' }] }, limit: 25 })
      .then(() => 'ran', (error: unknown) => error);
    const during = await search('77');
    const stillBuilding = during.disabledTypes.some((disabled) => disabled.entityType === 'slow');
    if (stillBuilding) expect(namingLabel('Slow', from)).toBe(0);
    expect(stillBuilding, 'the index of 200,000 nodes was online before the search ran').toBe(true);
    expect(during.disabledTypes.find((disabled) => disabled.entityType === 'slow')).toEqual({ entityType: 'slow', property: 'code', reason: 'index-building', typeSearched: false });
    expect(handWritten, 'the index was online before the hand-written search ran').toMatchObject({ code: 'SOURCE_UNAVAILABLE', reason: 'index-building' });
    expect(namingLabel('Slow', from)).toBe(0);
    await runAdmin(server, 'CALL db.awaitIndexes(300)');
    expect(await stableIds('77', 'slow')).toEqual(['77']);
  }, 300_000);

  it('refuses the entity read of a type whose stable-ID index is gone, with SOURCE_UNAVAILABLE, and no statement names its label', async () => {
    await runAdmin(server, 'DROP INDEX held_plain');
    const from = statements.length;
    const failure = await createEntityReader({ gate, mapping: { sources: [source()] }, access: communityAccess({ sources: [source()] }) })
      .read({ traceId: 'tr-entity-guard', principal: LOCAL_PRINCIPAL, sourceId: 'graph', entityType: 'held_by_index', stableId: '123', mask: false })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: 'SOURCE_UNAVAILABLE', reason: 'index-unavailable' });
    expect(namingLabel('HeldByIndex', from)).toBe(0);
  });
});
