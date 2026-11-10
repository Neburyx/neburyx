import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseMapping } from '../mapping/load.js';
import { account, DERIVED_ENTITIES, device } from '../testing/derived-fixtures.js';
import { makeToken } from '../reference/token.js';
import { gateRequest, TEST_REFERENCE_KEYS, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { CatalogError, createTemplateCatalog, type TemplateDefinition } from './catalog.js';
import type { ExecuteCall, ExecuteOutcome } from './executor.js';
import { isAggregateSample, isAggregateSummary } from './normalize/aggregate.js';
import { AGGREGATE_SAMPLE_ID, AGGREGATE_SUMMARY_ID, aggregateSampleTemplate, aggregateSummaryTemplate } from './templates/aggregate-evidence.js';
import { kindRank, supported } from './templates/expand-statement.js';

const ROW = { type: 'USES_TOOL', from: 'maker', to: 'tool', observed_at: 'seenAt', filterable: ['remark', 'seenAt', 'recordId'], evidence: ['recordId'] };
const mappingOf = (row: Record<string, unknown> = ROW, overrides: Record<string, unknown> = {}) => parseMapping(fileOf(baseSource({ id: 'demo', entities: DERIVED_ENTITIES, relationships: [row], ...overrides })), 'neburyx.yaml');

function rig(answer: (call: ExecuteCall) => ExecuteOutcome = () => ({ status: 'rows', rows: [] }), mapping = mappingOf(), offline?: { property: string }) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(answer(call))));
  const parts = testSourceGate(mapping, { executor, referenceKeys: TEST_REFERENCE_KEYS });
  const entries = onlineIndexesOf(source).filter((row) => offline === undefined || row.property !== offline.property).map((row) => ({ ...row }));
  const read = (templateId: string, params: unknown, limit = 25) => parts.gate.run(gateRequest({ sourceId: 'demo', templateId, params, limit, indexes: { sourceId: source.id, entries } as never }));
  return { ...parts, read, executor, source };
}

const end = (stableId: string, entityType: string) => ({ sourceId: 'demo', entityType, stableId });
const params = { type: 'USES_TOOL', ends: [end('A-1', 'maker'), end('D-1', 'tool')] };
const dataCalls = (executor: TestExecutor, templateId: string) => executor.calls.filter((call) => call.templateId === templateId);
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
};

const ANCHORS = [
  'MATCH (a:`Maker`) WHERE a.`makerId` IN [$ends[0].stableId, $ends[0].stableInteger] WITH a ORDER BY elementId(a) LIMIT 1',
  'MATCH (b:`Tool`) WHERE b.`toolId` IN [$ends[1].stableId, $ends[1].stableInteger] WITH a, b ORDER BY elementId(b) LIMIT 1',
];
const SEEN = 'r.`seenAt`';

describe('the statement of an aggregate read', () => {
  it('writes the sample sorted by the observed time, newest first, with the properties named one by one and the bound as the only limit', async () => {
    const { read, executor } = rig();
    await read(AGGREGATE_SAMPLE_ID, params);
    expect(dataCalls(executor, AGGREGATE_SAMPLE_ID)[0]?.cypher).toBe(
      [
        ...ANCHORS,
        `CALL { WITH a, b MATCH (a)-[r:\`USES_TOOL\`]->(b) WITH r ORDER BY CASE WHEN ${supported(SEEN)} THEN 0 ELSE 1 END, ${kindRank(SEEN)}, CASE WHEN ${supported(SEEN)} THEN ${SEEN} END DESC, elementId(r) LIMIT $limit RETURN collect({t: ${SEEN}, p0: r.\`remark\`}) AS sample }`,
        'RETURN a, b, sample',
      ].join('\n'),
    );
  });

  it('writes the sample with no ORDER BY for a row that maps no observed time: the first members the source returns', async () => {
    const { read, executor } = rig(undefined, mappingOf({ type: 'USES_TOOL', from: 'maker', to: 'tool', filterable: ['remark'] }));
    await read(AGGREGATE_SAMPLE_ID, params);
    expect(dataCalls(executor, AGGREGATE_SAMPLE_ID)[0]?.cypher).toContain('WITH r LIMIT $limit RETURN collect({p0: r.`remark`}) AS sample');
    expect(dataCalls(executor, AGGREGATE_SAMPLE_ID)[0]?.cypher.split('CALL')[1]).not.toContain('ORDER BY');
  });

  it('writes the summary as one count and the earliest and latest supported time of every member, the same for both orders', async () => {
    const { read, executor } = rig();
    await read(AGGREGATE_SUMMARY_ID, params, 1);
    const expected = [...ANCHORS, `CALL { WITH a, b MATCH (a)-[r:\`USES_TOOL\`]->(b) RETURN count(r) AS members, min(CASE WHEN ${supported(SEEN)} THEN ${SEEN} END) AS first, max(CASE WHEN ${supported(SEEN)} THEN ${SEEN} END) AS last }`, 'RETURN members, first, last'].join('\n');
    expect(dataCalls(executor, AGGREGATE_SUMMARY_ID)[0]?.cypher).toBe(expected);
    const plain = rig(undefined, mappingOf({ type: 'USES_TOOL', from: 'maker', to: 'tool' }));
    await plain.read(AGGREGATE_SUMMARY_ID, params, 1);
    expect(dataCalls(plain.executor, AGGREGATE_SUMMARY_ID)[0]?.cypher).toContain('RETURN count(r) AS members, null AS first, null AS last');
  });

  it('reads only the relationships with no usable ID for a type that has a stable_id', async () => {
    const { read, executor } = rig(undefined, mappingOf({ ...ROW, stable_id: 'useId' }));
    await read(AGGREGATE_SAMPLE_ID, params);
    await read(AGGREGATE_SUMMARY_ID, params, 1);
    for (const id of [AGGREGATE_SAMPLE_ID, AGGREGATE_SUMMARY_ID]) expect(dataCalls(executor, id)[0]?.cypher).toContain("MATCH (a)-[r:`USES_TOOL`]->(b) WHERE NOT ((r.`useId` IS :: STRING NOT NULL AND r.`useId` <> '') OR r.`useId` IS :: INTEGER NOT NULL)");
  });

  it('names no property but the row\'s filterable ones other than its observed time and evidence, and holds no write clause, SKIP or request text', async () => {
    const { read, executor } = rig();
    await read(AGGREGATE_SAMPLE_ID, params);
    const text = dataCalls(executor, AGGREGATE_SAMPLE_ID)[0]?.cypher ?? '';
    expect(text).not.toMatch(/recordId|properties\(|\{\.\*\}|SKIP|CREATE|MERGE|DELETE|SET |A-1|D-1/);
    expect(dataCalls(executor, AGGREGATE_SAMPLE_ID)[0]?.parameters).toMatchObject({ limit: 25 });
    expect(dataCalls(executor, AGGREGATE_SAMPLE_ID)[0]?.parameters).not.toHaveProperty('type');
    expect(dataCalls(executor, AGGREGATE_SAMPLE_ID)[0]?.accessMode).toBe('READ');
  });
});

describe('the refusals of an aggregate read', () => {
  it.each([
    ['an unmapped relationship type', { ...params, type: 'UNMAPPED' }],
    ['ends of the wrong entity types', { ...params, ends: [end('D-1', 'tool'), end('A-1', 'maker')] }],
    ['an unknown entity type', { ...params, ends: [end('A-1', 'nothing'), end('D-1', 'tool')] }],
    ['a third end', { ...params, ends: [end('A-1', 'maker'), end('D-1', 'tool'), end('D-2', 'tool')] }],
    ['an extra field', { ...params, cursor: 'x' }],
  ])('refuses %s before any read', async (_name, given) => {
    const { read, executor } = rig();
    expect(await codeOf(read(AGGREGATE_SAMPLE_ID, given))).toBe('INVALID_REQUEST');
    expect(await codeOf(read(AGGREGATE_SUMMARY_ID, given))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor, AGGREGATE_SAMPLE_ID)).toHaveLength(0);
  });

  it('refuses text that is not the token of a keyed end', async () => {
    const mapping = mappingOf(ROW, { entities: [{ type: 'maker', label: 'Maker', stable_id: 'makerId', pii: [{ property: 'makerId', class: 'name' }] }, DERIVED_ENTITIES[1]] });
    const { read, executor } = rig(undefined, mapping);
    expect(await codeOf(read(AGGREGATE_SAMPLE_ID, params))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor, AGGREGATE_SAMPLE_ID)).toHaveLength(0);
  });

  it('reads the token of a keyed end back: the statement gets the real value and its integer form, never the token', async () => {
    const mapping = mappingOf(ROW, { entities: [{ type: 'maker', label: 'Maker', stable_id: 'makerId', pii: [{ property: 'makerId', class: 'name' }] }, DERIVED_ENTITIES[1]] });
    const { read, executor } = rig(undefined, mapping);
    const token = makeToken(TEST_REFERENCE_KEYS, { sourceId: 'demo', entityType: 'maker' }, '9007199254740993');
    await read(AGGREGATE_SAMPLE_ID, { type: 'USES_TOOL', ends: [end(token, 'maker'), end('D-1', 'tool')] });
    const sent = dataCalls(executor, AGGREGATE_SAMPLE_ID)[0]?.parameters['ends'];
    expect(sent).toMatchObject([{ entityType: 'maker', stableId: '9007199254740993', stableInteger: expect.anything() }, { entityType: 'tool', stableId: 'D-1' }]);
    expect(JSON.stringify(sent)).not.toContain(token);
  });

  it('refuses a limit above max_page', async () => {
    const { read, executor } = rig();
    expect(await codeOf(read(AGGREGATE_SAMPLE_ID, params, 51))).toBe('QUERY_BUDGET_EXCEEDED');
    expect(dataCalls(executor, AGGREGATE_SAMPLE_ID)).toHaveLength(0);
  });

  it.each([['makerId'], ['toolId']])('refuses as SOURCE_UNAVAILABLE, before any data statement, when the index on %s is not online', async (property) => {
    const { read, executor } = rig(undefined, mappingOf(), { property });
    expect(await codeOf(read(AGGREGATE_SAMPLE_ID, params))).toBe('SOURCE_UNAVAILABLE');
    expect(dataCalls(executor, AGGREGATE_SAMPLE_ID)).toHaveLength(0);
  });
});

describe('what an aggregate read returns', () => {
  const a = account('A-1');
  const b = device('D-1');
  const members = [{ t: { $type: 'dateTime', value: '2026-01-02T10:00:00Z' }, p0: 'web', elementId: '4:leak:1', recordId: 'SECRET' }];

  it('holds both ends and the sampled members with no element ID, and nothing the mapping does not name', async () => {
    const { read } = rig(() => ({ status: 'rows', rows: [{ a, b, sample: members }] }));
    const page = await read(AGGREGATE_SAMPLE_ID, params);
    const [item] = page.items;
    if (!isAggregateSample(item)) throw new Error('no sample item');
    expect(item.aggregateSample).toEqual({ order: 'observed-newest', rows: [{ observedAt: '2026-01-02T10:00:00Z', properties: [{ key: 'remark', value: 'web', dataClass: 'text', masked: false }] }] });
    expect(item.nodes.map((node) => node.ref.stableId).sort()).toEqual(['A-1', 'D-1']);
    const text = JSON.stringify(item);
    for (const leak of ['4:leak:1', 'SECRET', a.elementId, b.elementId]) expect(text).not.toContain(leak);
  });

  it('reads the count and the earliest and latest time of the summary row, and flags times of different kinds', async () => {
    const { read } = rig(() => ({ status: 'rows', rows: [{ members: 7, first: { $type: 'dateTime', value: '2026-01-01T00:00:00Z' }, last: { $type: 'localDateTime', value: '2026-02-01T00:00:00' } }] }));
    const [item] = (await read(AGGREGATE_SUMMARY_ID, params, 1)).items;
    if (!isAggregateSummary(item)) throw new Error('no summary item');
    expect(item.aggregateSummary).toEqual({ members: 7, first: '2026-01-01T00:00:00Z', last: '2026-01-01T00:00:00Z', mixed: true });
  });

  it('gives an empty item when no end is found, and no count for a count that is not a whole number', async () => {
    const none = rig(() => ({ status: 'rows', rows: [] }));
    expect((await none.read(AGGREGATE_SAMPLE_ID, params)).items.every((item) => isAggregateSample(item) && item.aggregateSample.rows.length === 0)).toBe(true);
    const odd = rig(() => ({ status: 'rows', rows: [{ members: -1, first: null, last: null }] }));
    const [item] = (await odd.read(AGGREGATE_SUMMARY_ID, params, 1)).items;
    expect(isAggregateSummary(item) && item.aggregateSummary.members).toBeUndefined();
  });

  it('refuses a read that returns a second row: one aggregate row is declared', async () => {
    const { read } = rig(() => ({ status: 'rows', rows: [{ members: 1 }, { members: 2 }] }));
    expect(await codeOf(read(AGGREGATE_SUMMARY_ID, params, 1))).not.toBe('ok');
  });
});

describe('the catalog\'s check of an aggregate template', () => {
  const failure = (definition: Partial<TemplateDefinition>): string => {
    try {
      createTemplateCatalog({ templates: [{ ...aggregateSampleTemplate, ...definition }] });
      return 'accepted';
    } catch (error) {
      return error instanceof CatalogError ? error.message : 'not a CatalogError';
    }
  };

  it('accepts both templates as declared', () => {
    expect(() => createTemplateCatalog({ templates: [aggregateSampleTemplate, aggregateSummaryTemplate] })).not.toThrow();
  });

  it.each([
    ['a second marker', { cypher: '@aggregateRead(type) @aggregateRead(type)' }, 'declares an aggregate read and its Cypher is not exactly its one aggregate read marker'],
    ['a paged shape', { paged: true }, 'is paged and declares rows or cutMeans'],
    ['no rows declaration', { rows: undefined, cutMeans: 'lowerBound' as const }, "declares an aggregate read and is also another kind of template, paged, profiled or not declared rows: 'one'"],
    ['no declaration for its marker', { aggregateRead: undefined }, 'uses the aggregate read marker without declaring an aggregate read'],
    ['ends that are not reference lists', { referenceLists: [] }, 'declares an aggregate read for parameters its schema does not have as text and a list, or does not list the ends as reference lists'],
    ['no index needs', { indexNeeds: undefined }, 'declares an aggregate read and does not name its indexes and the properties it uses'],
  ])('refuses %s', (_name, definition, message) => {
    expect(failure(definition as Partial<TemplateDefinition>)).toBe(`the template aggregate-sample ${message}`);
  });
});
