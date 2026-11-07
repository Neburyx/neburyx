import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseMapping } from '../mapping/load.js';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import type { ExecuteCall, ExecuteOutcome } from './executor.js';
import { DEGREE_PREVIEW_BOUNDED_ID, DEGREE_PREVIEW_CHEAP_ID } from './templates/degree-preview.js';
import { degreePairsOf } from './templates/degree-pairs.js';

const ENTITIES = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId' },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
  { type: 'island', label: 'Island', stable_id: 'islandId' },
];
const RELATIONSHIPS = [
  { type: 'LINKS', from: 'widget', to: 'gadget' },
  { type: 'LINKS', from: 'widget', to: 'widget' },
  { type: 'KNOWS', from: 'gadget', to: 'widget' },
  { type: 'LINKS', from: 'widget', to: 'island' },
];

function mappingWith(overrides: Record<string, unknown> = {}) {
  return parseMapping(fileOf(baseSource({ id: 'demo', entities: ENTITIES, relationships: RELATIONSHIPS, ...overrides })), 'neburyx.yaml');
}

function rig(answer: (call: ExecuteCall) => ExecuteOutcome, mapping = mappingWith(), templateId = DEGREE_PREVIEW_BOUNDED_ID) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(answer(call))));
  const parts = testSourceGate(mapping, { executor });
  const read = (params: unknown, limit = 1) => parts.gate.run(gateRequest({ sourceId: 'demo', templateId, params, limit, indexes: { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) } }));
  return { ...parts, read, executor, source };
}

const rowOf = (...counts: number[]): ExecuteOutcome => ({ status: 'rows', rows: [Object.fromEntries(counts.map((count, index) => [`c${index}`, count]))] });
const dataCalls = (executor: TestExecutor, templateId = DEGREE_PREVIEW_BOUNDED_ID) => executor.calls.filter((call) => call.templateId === templateId);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
}

describe('the pairs of an entity type', () => {
  it('lists each relationship type and direction once, in the order of the mapping rows', () => {
    const { source } = rig(() => rowOf(0));
    expect(degreePairsOf(source.relationships, 'widget')).toEqual([
      { relationshipType: 'LINKS', direction: 'out' },
      { relationshipType: 'LINKS', direction: 'in' },
      { relationshipType: 'KNOWS', direction: 'in' },
    ]);
    expect(degreePairsOf(source.relationships, 'island')).toEqual([{ relationshipType: 'LINKS', direction: 'in' }]);
  });
});

describe('a bounded degree read the gate runs', () => {
  it('writes the anchor and one capped count for each pair, with quoted names from the mapping, and the stable ID and the cap as parameters', async () => {
    const { read, executor } = rig(() => rowOf(1, 2, 3));
    await read({ entityType: 'widget', stableId: 'W-1' });
    const [call] = dataCalls(executor);
    expect(call?.cypher).toBe(
      [
        'MATCH (n:`Widget`) WHERE n.`widgetId` IN [$stableId, $stableInteger] WITH n ORDER BY elementId(n) LIMIT $limit + 1',
        'CALL { WITH n MATCH (n)-[:`LINKS`]->() WITH 1 AS hit LIMIT $countCap + 1 RETURN count(*) AS c0 }',
        'CALL { WITH n MATCH (n)<-[:`LINKS`]-() WITH 1 AS hit LIMIT $countCap + 1 RETURN count(*) AS c1 }',
        'CALL { WITH n MATCH (n)<-[:`KNOWS`]-() WITH 1 AS hit LIMIT $countCap + 1 RETURN count(*) AS c2 }',
        'RETURN c0, c1, c2',
      ].join('\n'),
    );
    expect(call?.cypher).not.toContain('W-1');
    expect(call?.parameters).toMatchObject({ stableId: 'W-1', limit: 1, countCap: 500 });
    expect(call?.accessMode).toBe('READ');
  });

  it('cuts the counts at the heavy-operation threshold of the source and not at the page limit', async () => {
    const mapping = mappingWith({ budgets: { max_page: 50, heavy_op_threshold: 7 } });
    const { read, executor } = rig(() => rowOf(0, 0, 0), mapping);
    await read({ entityType: 'widget', stableId: 'W-1' });
    expect(dataCalls(executor)[0]?.parameters).toMatchObject({ countCap: 7, limit: 1 });
  });

  it.each([
    ['zero', 0, { value: 0, quality: 'exact' }],
    ['the cap', 500, { value: 500, quality: 'exact' }],
    ['the cap plus one', 501, { value: 500, quality: 'lowerBound' }],
  ])('reads %s as an exact count or a lower bound that says the cap', async (_name, read, expected) => {
    const { read: run } = rig(() => rowOf(read, 0, 0));
    const page = await run({ entityType: 'widget', stableId: 'W-1' });
    expect(page.items[0]).toEqual({ found: true, counts: [expected, { value: 0, quality: 'exact' }, { value: 0, quality: 'exact' }], duplicate: false });
  });

  it('flags a second node with the same stable ID and counts the first', async () => {
    const { read } = rig(() => ({ status: 'rows', rows: [{ c0: 4, c1: 0, c2: 0 }, { c0: 9, c1: 9, c2: 9 }] }));
    const page = await read({ entityType: 'widget', stableId: 'W-1' });
    expect(page.items[0]).toMatchObject({ found: true, duplicate: true, counts: [{ value: 4 }, { value: 0 }, { value: 0 }] });
  });

  it('answers no counts for a node the source does not hold', async () => {
    const { read } = rig(() => ({ status: 'rows', rows: [] }));
    expect((await read({ entityType: 'widget', stableId: 'nobody' })).items).toEqual([{ found: false }]);
  });

  it('reads nothing for an entity type with no mapped relationship', async () => {
    const mapping = mappingWith({ relationships: [{ type: 'LINKS', from: 'widget', to: 'gadget' }] });
    const { read, executor } = rig(() => rowOf(0), mapping);
    expect((await read({ entityType: 'island', stableId: 'I-1' })).items).toEqual([{ found: false }]);
    expect(dataCalls(executor)).toEqual([]);
  });

  it('sends a stable ID that is a canonical 64-bit integer as text and as that integer, and any other text as text alone', async () => {
    const { read, executor } = rig(() => rowOf(0, 0, 0));
    await read({ entityType: 'widget', stableId: '9223372036854775807' });
    await read({ entityType: 'widget', stableId: '007' });
    await read({ entityType: 'widget', stableId: '9223372036854775808' });
    const [first, second, third] = dataCalls(executor);
    expect(first?.parameters['stableInteger']).toEqual({ $type: 'integer', value: '9223372036854775807' });
    expect(second?.parameters['stableInteger']).toBeNull();
    expect(third?.parameters['stableInteger']).toBeNull();
  });
});

describe('a bounded degree read the gate refuses', () => {
  it.each([
    ['an entity type the mapping does not name', { entityType: 'nothing', stableId: 'W-1' }],
    ['an entity type with a backtick', { entityType: 'widget` OR 1=1 //', stableId: 'W-1' }],
    ['a cap in the request', { entityType: 'widget', stableId: 'W-1', countCap: 100000 }],
    ['a relationship type in the request', { entityType: 'widget', stableId: 'W-1', relationshipType: 'LINKS' }],
    ['an empty stable ID', { entityType: 'widget', stableId: '' }],
    ['a stable ID over the limit of a value', { entityType: 'widget', stableId: 'x'.repeat(100_001) }],
    ['a stable ID that is not text', { entityType: 'widget', stableId: 7 }],
    ['no entity type', { stableId: 'W-1' }],
  ])('refuses %s with INVALID_REQUEST and runs no statement', async (_name, params) => {
    const { read, executor } = rig(() => rowOf(0, 0, 0));
    expect(await codeOf(read(params))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor)).toEqual([]);
  });

  it.each([
    ['a count above the cap plus one', [{ c0: 502, c1: 0, c2: 0 }]],
    ['a negative count', [{ c0: -1, c1: 0, c2: 0 }]],
    ['a fraction', [{ c0: 1.5, c1: 0, c2: 0 }]],
    ['a value that is not a number', [{ c0: '3', c1: 0, c2: 0 }]],
    ['a count beyond the largest safe integer', [{ c0: Number.MAX_SAFE_INTEGER + 2, c1: 0, c2: 0 }]],
    ['a column out of order', [{ c1: 0, c0: 0, c2: 0 }]],
    ['a row with no column', [{}]],
    ['fewer columns than pairs', [{ c0: 0, c1: 0 }]],
    ['more columns than pairs', [{ c0: 0, c1: 0, c2: 0, c3: 0 }]],
  ])('refuses %s as an unreadable answer and returns no count', async (_name, rows) => {
    const { read } = rig(() => ({ status: 'rows', rows }));
    expect(await codeOf(read({ entityType: 'widget', stableId: 'W-1' }))).toBe('INTERNAL_ERROR');
  });

  it('refuses a read of an entity type whose stable-ID index is not online before it reads any data', async () => {
    const mapping = mappingWith();
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('the mapping has no source');
    const executor = new TestExecutor(withOnlineIndexes(source, () => Promise.resolve(rowOf(0, 0, 0))));
    const { gate } = testSourceGate(mapping, { executor });
    const entries = onlineIndexesOf(source).filter((entry) => !JSON.stringify(entry).includes('widgetId')).map((row) => ({ ...row }));
    const code = await codeOf(gate.run(gateRequest({ sourceId: 'demo', templateId: DEGREE_PREVIEW_BOUNDED_ID, params: { entityType: 'widget', stableId: 'W-1' }, limit: 1, indexes: { sourceId: 'demo', entries } })));
    expect(['SOURCE_UNAVAILABLE', 'INVALID_REQUEST']).toContain(code);
    expect(dataCalls(executor)).toEqual([]);
  });
});

describe('a cheap degree read the gate runs', () => {
  const cheap = (answer: (call: ExecuteCall) => ExecuteOutcome, mapping = mappingWith()) => rig(answer, mapping, DEGREE_PREVIEW_CHEAP_ID);

  it('writes the anchor and one count expression for each pair, with no cap and no limit on the counts', async () => {
    const { read, executor } = cheap(() => rowOf(1, 2, 3));
    await read({ entityType: 'widget', stableId: 'W-1' });
    const [call] = dataCalls(executor, DEGREE_PREVIEW_CHEAP_ID);
    expect(call?.cypher).toBe(
      [
        'MATCH (n:`Widget`) WHERE n.`widgetId` IN [$stableId, $stableInteger] WITH n ORDER BY elementId(n) LIMIT $limit + 1',
        'RETURN COUNT { (n)-[:`LINKS`]->() } AS c0, COUNT { (n)<-[:`LINKS`]-() } AS c1, COUNT { (n)<-[:`KNOWS`]-() } AS c2',
      ].join('\n'),
    );
    expect(call?.parameters).not.toHaveProperty('countCap');
    expect(call?.parameters).toMatchObject({ stableId: 'W-1', limit: 1 });
  });

  it('reads every count as exact, however large', async () => {
    const { read } = cheap(() => rowOf(0, 100_000, 7));
    const page = await read({ entityType: 'widget', stableId: 'W-1' });
    expect(page.items[0]).toEqual({ found: true, counts: [{ value: 0, quality: 'exact' }, { value: 100_000, quality: 'exact' }, { value: 7, quality: 'exact' }], duplicate: false });
  });

  it('flags a second node with the same stable ID and counts the first', async () => {
    const { read } = cheap(() => ({ status: 'rows', rows: [{ c0: 4, c1: 0, c2: 0 }, { c0: 9, c1: 9, c2: 9 }] }));
    expect((await read({ entityType: 'widget', stableId: 'W-1' })).items[0]).toMatchObject({ found: true, duplicate: true, counts: [{ value: 4 }, { value: 0 }, { value: 0 }] });
  });

  it('answers no counts for a node the source does not hold', async () => {
    const { read } = cheap(() => ({ status: 'rows', rows: [] }));
    expect((await read({ entityType: 'widget', stableId: 'nobody' })).items).toEqual([{ found: false }]);
  });

  it.each([
    ['a negative count', [{ c0: -1, c1: 0, c2: 0 }]],
    ['a fraction', [{ c0: 1.5, c1: 0, c2: 0 }]],
    ['a count beyond the largest safe integer', [{ c0: Number.MAX_SAFE_INTEGER + 2, c1: 0, c2: 0 }]],
    ['a value that is not a number', [{ c0: '3', c1: 0, c2: 0 }]],
    ['fewer columns than pairs', [{ c0: 0, c1: 0 }]],
    ['more columns than pairs', [{ c0: 0, c1: 0, c2: 0, c3: 0 }]],
  ])('refuses %s as an unreadable answer and returns no count', async (_name, rows) => {
    const { read } = cheap(() => ({ status: 'rows', rows }));
    expect(await codeOf(read({ entityType: 'widget', stableId: 'W-1' }))).toBe('INTERNAL_ERROR');
  });

  it('refuses a cap, a relationship type or an unmapped entity type in the request, and a read of nothing for an entity type with no pair', async () => {
    const { read, executor } = cheap(() => rowOf(0, 0, 0));
    expect(await codeOf(read({ entityType: 'widget', stableId: 'W-1', countCap: 5 }))).toBe('INVALID_REQUEST');
    expect(await codeOf(read({ entityType: 'nothing', stableId: 'W-1' }))).toBe('INVALID_REQUEST');
    expect(dataCalls(executor, DEGREE_PREVIEW_CHEAP_ID)).toEqual([]);
    const lonely = cheap(() => rowOf(0), mappingWith({ relationships: [{ type: 'LINKS', from: 'widget', to: 'gadget' }] }));
    expect((await lonely.read({ entityType: 'island', stableId: 'I-1' })).items).toEqual([{ found: false }]);
    expect(dataCalls(lonely.executor, DEGREE_PREVIEW_CHEAP_ID)).toEqual([]);
  });

  it('sends a canonical 64-bit integer stable ID as text and as that integer', async () => {
    const { read, executor } = cheap(() => rowOf(0, 0, 0));
    await read({ entityType: 'widget', stableId: '-9223372036854775808' });
    expect(dataCalls(executor, DEGREE_PREVIEW_CHEAP_ID)[0]?.parameters['stableInteger']).toEqual({ $type: 'integer', value: '-9223372036854775808' });
  });
});
