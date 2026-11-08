import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { parseMapping } from '../mapping/load.js';
import { gateRequest, TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { onlineIndexesOf, withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { communitySeams } from '../seams/community-seams.js';
import type { ExecuteCall, ExecuteOutcome } from './executor.js';
import { DEGREE_PREVIEW_BOUNDED_ID, DEGREE_PREVIEW_CHEAP_ID } from './templates/degree-preview.js';

const ENTITIES = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', degree: [{ type: 'LINKS', direction: 'out', property: 'linksOut', observed_at: 'linksOutAt' }, { type: 'KNOWS', direction: 'in', property: 'knowsIn' }] },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
];
const RELATIONSHIPS = [
  { type: 'LINKS', from: 'widget', to: 'gadget' },
  { type: 'LINKS', from: 'widget', to: 'widget' },
  { type: 'KNOWS', from: 'gadget', to: 'widget' },
];
const CAP = 500;
const PARAMS = { entityType: 'widget', stableId: 'W-1' };

const mappingWith = (entities: readonly Record<string, unknown>[] = ENTITIES) => parseMapping(fileOf(baseSource({ id: 'demo', entities, relationships: RELATIONSHIPS })), 'neburyx.yaml');

function rig(answer: (call: ExecuteCall) => ExecuteOutcome, mapping = mappingWith(), templateId = DEGREE_PREVIEW_BOUNDED_ID, busy = false) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(answer(call))));
  const defaults = communitySeams();
  const seams = { policy: defaults.policy, audit: defaults.audit, coordinator: busy ? { acquireRead: () => Promise.resolve({ status: 'busy' as const }) } : defaults.coordinator };
  const parts = testSourceGate(mapping, { executor, seams });
  const read = (params: unknown = PARAMS) => parts.gate.run(gateRequest({ sourceId: 'demo', templateId, params, limit: 1, indexes: { sourceId: source.id, entries: onlineIndexesOf(source).map((row) => ({ ...row })) } }));
  return { read, executor, source };
}

const rowOf = (row: Record<string, unknown>): ExecuteOutcome => ({ status: 'rows', rows: [row] });
const dataCalls = (executor: TestExecutor, templateId = DEGREE_PREVIEW_BOUNDED_ID) => executor.calls.filter((call) => call.templateId === templateId);
const countsOf = async (read: () => ReturnType<ReturnType<typeof rig>['read']>) => (await read()).items[0];

describe('a mapping that declares degree properties', () => {
  it('loads, and the entity model holds the declaration only where the mapping has one', () => {
    const { source } = rig(() => rowOf({}));
    expect(source.entities[0]?.degree).toEqual([{ type: 'LINKS', direction: 'out', property: 'linksOut', observedAt: 'linksOutAt' }, { type: 'KNOWS', direction: 'in', property: 'knowsIn' }]);
    expect(source.entities[1]).not.toHaveProperty('degree');
  });

  it('keeps the configuration hash of a mapping with no degree key: an empty list is the same mapping', () => {
    const plain = rig(() => rowOf({}), mappingWith([{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }, ENTITIES[1] ?? {}])).source;
    const empty = rig(() => rowOf({}), mappingWith([{ type: 'widget', label: 'Widget', stable_id: 'widgetId', degree: [] }, ENTITIES[1] ?? {}])).source;
    expect(empty.configHash).toBe(plain.configHash);
    expect(JSON.stringify(plain)).not.toContain('degree');
  });
});

describe('the bounded read of a type with declared degree properties', () => {
  it('reads each declared property of the anchored node in the same statement, as a column named by the position of its pair', async () => {
    const { read, executor } = rig(() => rowOf({ c0: 0, c1: 0, c2: 0, p0: null, t0: null, p2: null }));
    await read();
    const [call] = dataCalls(executor);
    expect(call?.cypher).toBe(
      [
        'MATCH (n:`Widget`) WHERE n.`widgetId` IN [$stableId, $stableInteger] WITH n ORDER BY elementId(n) LIMIT $limit + 1',
        'CALL { WITH n MATCH (n)-[:`LINKS`]->() WITH 1 AS hit LIMIT $countCap + 1 RETURN count(*) AS c0 }',
        'CALL { WITH n MATCH (n)<-[:`LINKS`]-() WITH 1 AS hit LIMIT $countCap + 1 RETURN count(*) AS c1 }',
        'CALL { WITH n MATCH (n)<-[:`KNOWS`]-() WITH 1 AS hit LIMIT $countCap + 1 RETURN count(*) AS c2 }',
        'RETURN c0, c1, c2, n.`linksOut` AS p0, n.`linksOutAt` AS t0, n.`knowsIn` AS p2',
      ].join('\n'),
    );
    expect(call?.accessMode).toBe('READ');
  });

  it('takes the number of a property above the cap as an estimate that keeps the cap it proved', async () => {
    const { read } = rig(() => rowOf({ c0: CAP + 1, c1: 3, c2: 0, p0: 10_000, t0: null, p2: null }));
    expect(await countsOf(read)).toEqual({
      found: true,
      counts: [{ value: 10_000, quality: 'estimated', provenFloor: CAP }, { value: 3, quality: 'exact' }, { value: 0, quality: 'exact' }],
      duplicate: false,
    });
  });

  it('leaves an exact count exact, whatever the property says', async () => {
    const { read } = rig(() => rowOf({ c0: CAP, c1: 3, c2: 7, p0: 9_999, t0: '2026-01-01', p2: 9_999 }));
    expect(await countsOf(read)).toMatchObject({ counts: [{ value: CAP, quality: 'exact' }, { value: 3, quality: 'exact' }, { value: 7, quality: 'exact' }] });
  });

  it('leaves a lower bound a lower bound when the property is not above the cap or is not there', async () => {
    const { read } = rig(() => rowOf({ c0: CAP + 1, c1: 0, c2: CAP + 1, p0: CAP, t0: '2026-01-01', p2: null }));
    expect(await countsOf(read)).toMatchObject({ counts: [{ value: CAP, quality: 'lowerBound' }, { value: 0, quality: 'exact' }, { value: CAP, quality: 'lowerBound' }] });
  });

  it('leaves a pair with no declaration as it was read', async () => {
    const { read } = rig(() => rowOf({ c0: 1, c1: CAP + 1, c2: 2, p0: 77, t0: null, p2: 88 }));
    expect(await countsOf(read)).toMatchObject({ counts: [{ value: 1, quality: 'exact' }, { value: CAP, quality: 'lowerBound' }, { value: 2, quality: 'exact' }] });
  });

  it.each([
    ['a property column the mapping did not declare', { c0: 0, c1: 0, c2: 0, p1: 5, p0: 5, t0: null, p2: 5 }],
    ['a declared column missing', { c0: 0, c1: 0, c2: 0, p0: 5, p2: 5 }],
    ['the columns out of order', { c0: 0, c1: 0, c2: 0, p2: 5, p0: 5, t0: null }],
    ['a count above the cap plus one', { c0: CAP + 2, c1: 0, c2: 0, p0: null, t0: null, p2: null }],
  ])('refuses %s as an unreadable answer', async (_name, row) => {
    const { read } = rig(() => rowOf(row));
    await expect(read()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it.each([
    ['QUERY_TIMEOUT', { status: 'timeout' } as const],
    ['SOURCE_UNAVAILABLE', { status: 'unavailable', reason: 'unreachable' } as const],
  ])('gives the error the read gives (%s) and builds no estimate from it', async (code, outcome) => {
    const { read } = rig(() => outcome);
    const error: unknown = await read().then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  });
});

describe('a read the source refuses', () => {
  it('gives SOURCE_BUSY when no read slot is free, and reads nothing', async () => {
    const { read, executor } = rig(() => rowOf({ c0: CAP + 1, c1: 0, c2: 0, p0: 10_000, t0: null, p2: null }), mappingWith(), DEGREE_PREVIEW_BOUNDED_ID, true);
    await expect(read()).rejects.toMatchObject({ code: 'SOURCE_BUSY' });
    expect(dataCalls(executor)).toEqual([]);
  });
});

describe('the date of an estimated count', () => {
  const estimated = (date: unknown) => ({ c0: CAP + 1, c1: 0, c2: 0, p0: 10_000, t0: date, p2: null });
  const dateOf = async (date: unknown) => {
    const { read } = rig(() => rowOf(estimated(date)));
    const item = await countsOf(read);
    const counts: unknown = typeof item === 'object' && item !== null ? Reflect.get(item, 'counts') : undefined;
    return Array.isArray(counts) ? (counts[0] as unknown) : undefined;
  };

  it.each([
    ['a date', { $type: 'date', value: '2026-01-02' }, '2026-01-02'],
    ['a datetime', { $type: 'dateTime', value: '2026-01-02T03:04:05Z' }, '2026-01-02T03:04:05Z'],
    ['a local datetime', { $type: 'localDateTime', value: '2026-01-02T03:04:05' }, '2026-01-02T03:04:05'],
    ['text', '2026-01-02 batch', '2026-01-02 batch'],
  ])('is %s as its text', async (_name, stored, text) => {
    expect(await dateOf(stored)).toEqual({ value: 10_000, quality: 'estimated', provenFloor: CAP, observedAt: text });
  });

  it.each([
    ['absent', null],
    ['empty text', ''],
    ['text of only whitespace', '   '],
    ['a time', { $type: 'time', value: '03:04:05Z' }],
    ['a local time', { $type: 'localTime', value: '03:04:05' }],
    ['a duration', { $type: 'duration', value: 'P3D' }],
    ['a number', 20260102],
    ['an integer beyond the safe range', { $type: 'integer', value: '9223372036854775807' }],
    ['a point', { $type: 'point', srid: 4326, x: 1, y: 2 }],
    ['a list', ['2026-01-02']],
    ['a map', { when: '2026-01-02' }],
  ])('is left out when it is %s, and the count is still estimated', async (_name, stored) => {
    expect(await dateOf(stored)).toEqual({ value: 10_000, quality: 'estimated', provenFloor: CAP });
  });

  it('is never read into a count that took no estimate', async () => {
    const { read } = rig(() => rowOf({ c0: CAP, c1: 0, c2: 0, p0: 10_000, t0: '2026-01-02', p2: null }));
    const item = await countsOf(read);
    expect(item).toMatchObject({ counts: [{ value: CAP, quality: 'exact' }, { quality: 'exact' }, { quality: 'exact' }] });
    expect(JSON.stringify(item)).not.toContain('observedAt');
  });
});

describe('the cheap read of a type with declared degree properties', () => {
  it('writes no property column, and every count is exact', async () => {
    const { read, executor } = rig(() => rowOf({ c0: 100_000, c1: 0, c2: 0 }), mappingWith(), DEGREE_PREVIEW_CHEAP_ID);
    const item = await countsOf(read);
    expect(dataCalls(executor, DEGREE_PREVIEW_CHEAP_ID)[0]?.cypher).not.toContain('linksOut');
    expect(item).toMatchObject({ counts: [{ value: 100_000, quality: 'exact' }, { value: 0, quality: 'exact' }, { value: 0, quality: 'exact' }] });
  });
});
