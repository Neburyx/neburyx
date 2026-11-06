import { searchResultSchema, type SearchResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { warningsOf } from '../gate/normalize/drops.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { postSearch, relatedCalls, RELATED_ENTITIES, searchMappingOf, startSearchApp } from '../testing/search-app.js';
import { searchModelOf, type StoredNode } from '../testing/search-fixtures.js';

const TEXT = 'X-1';
const referencing = (count: number): StoredNode[] =>
  Array.from({ length: count }, (_, index) => ({ elementId: `4:r:${index + 1}`, label: 'Gadget', properties: { gadgetId: `GT-${String(index + 1).padStart(3, '0')}`, widgetRef: TEXT } }));

async function searched(stored: readonly StoredNode[], mappingOverrides: Record<string, unknown> = {}, respond?: (call: ExecuteCall) => Promise<ExecuteOutcome>) {
  const mapping = searchMappingOf({ entities: RELATED_ENTITIES, ...mappingOverrides });
  const app = await startSearchApp({ mapping, respond: respond ?? searchModelOf(stored) });
  const answer: SearchResult = searchResultSchema.parse((await postSearch(app.app, { sourceId: 'demo', text: TEXT })).json());
  await app.app.close();
  return { answer, executor: app.executor };
}

describe('the count of the related group', () => {
  it.each([
    [24, 24, 'exact'],
    [25, 25, 'exact'],
    [26, 25, 'lowerBound'],
  ])('shows %i referencing records as %i hits and an %s count', async (records, hits, quality) => {
    const { answer, executor } = await searched(referencing(records));
    expect(answer.related.hits).toHaveLength(hits);
    expect(answer.related.count).toEqual({ value: hits, quality, scope: 'search:related' });
    expect(answer.cap).toBe(25);
    expect(relatedCalls(executor)[0]?.rowLimit).toBe(26);
  });

  it.each([
    [10, 10, 'exact'],
    [11, 10, 'lowerBound'],
  ])('shows %i referencing records as %i hits and an %s count for a source whose max_page is 10, and sends no limit above it', async (records, hits, quality) => {
    const { answer, executor } = await searched(referencing(records), { budgets: { max_page: 10, default_page: 10 } });
    expect(answer.related.hits).toHaveLength(hits);
    expect(answer.related.count).toEqual({ value: hits, quality, scope: 'search:related' });
    expect(answer.cap).toBe(10);
    expect(relatedCalls(executor)[0]?.rowLimit).toBe(11);
  });

  it('holds the number of hits it has, as a lower bound, when the read overflowed and normalization left rows out or merged them', async () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, index) => plainNode(['Gadget'], { gadgetId: `GT-${index + 1}`, widgetRef: TEXT }, `4:g:${index + 1}`)),
      plainNode(['Nothing'], { gadgetId: 'N-1' }, '4:n:1'),
      plainNode(['Gadget'], { widgetRef: TEXT }, '4:g:nokey'),
      plainNode(['Gadget'], { gadgetId: 'GT-1', widgetRef: TEXT }, '4:g:dup'),
      plainNode(['Gadget'], { gadgetId: 'GT-21', widgetRef: TEXT }, '4:g:21'),
      plainNode(['Gadget'], { gadgetId: 'GT-22', widgetRef: TEXT }, '4:g:22'),
      plainNode(['Gadget'], { gadgetId: 'GT-23', widgetRef: TEXT }, '4:g:23'),
    ];
    const respond = (call: ExecuteCall) => Promise.resolve(call.templateId === 'entity-related' ? entityRows(...rows.slice(0, call.rowLimit)) : entityRows());
    const { answer } = await searched([], {}, (call) => (call.templateId === 'schema-indexes' ? searchModelOf([])(call) : respond(call)));
    expect(answer.related.hits).toHaveLength(22);
    expect(answer.related.hits.length).toBeLessThan(25);
    expect(answer.related.count).toEqual({ value: answer.related.hits.length, quality: 'lowerBound', scope: 'search:related' });
    expect(answer.dropped).toMatchObject({ 'not-mapped': 1, 'no-stable-id': 1 });
  });

  it('holds an exact count of the hits when the read did not overflow, however many rows normalization left out', async () => {
    const rows = [plainNode(['Gadget'], { gadgetId: 'GT-1', widgetRef: TEXT }, '4:g:1'), plainNode(['Nothing'], { gadgetId: 'N-1' }, '4:n:1')];
    const { answer } = await searched([], {}, (call) => Promise.resolve(call.templateId === 'entity-related' ? entityRows(...rows) : entityRows()));
    expect(answer.related.count).toEqual({ value: 1, quality: 'exact', scope: 'search:related' });
    expect(answer.dropped['not-mapped']).toBe(1);
  });
});

describe('a record that is both an exact match and a referencing record', () => {
  const stored: StoredNode[] = [
    { elementId: '4:s:1', label: 'Widget', properties: { widgetId: TEXT, batchRef: TEXT } },
    { elementId: '4:s:2', label: 'Widget', properties: { widgetId: 'W-2', batchRef: TEXT } },
  ];

  it('is listed in both groups and counted in each, and the related-only record is never in the exact group or its count', async () => {
    const { answer } = await searched(stored);
    expect(answer.exact.map((node) => node.ref.stableId)).toEqual([TEXT]);
    expect(answer.counts.exact).toMatchObject({ value: 1, quality: 'exact' });
    expect(answer.related.hits.map((hit) => hit.node.ref.stableId).sort()).toEqual(['W-2', TEXT]);
    expect(answer.related.count).toMatchObject({ value: 2, quality: 'exact' });
  });

  it('does not filter the related group against the exact one: the related read is the same with or without the exact match', async () => {
    const { executor } = await searched(stored);
    const [related] = relatedCalls(executor);
    expect(related?.cypher).not.toContain('widgetId');
    expect(related?.parameters).toMatchObject({ text: TEXT });
  });
});

describe('the diagnostics of the two groups', () => {
  const rows = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    if (call.templateId === 'entity-search') return Promise.resolve(entityRows(plainNode(['Nothing'], { x: 1 }, '4:e:1'), plainNode(['Widget'], { widgetId: TEXT }, '4:e:2')));
    return Promise.resolve(entityRows(plainNode(['Nothing'], { x: 1 }, '4:r:1'), plainNode(['Gadget'], { widgetRef: TEXT }, '4:r:2'), plainNode(['Gadget'], { gadgetId: 'GT-1', widgetRef: TEXT }, '4:r:3')));
  };
  const respond = (call: ExecuteCall) => (call.templateId === 'schema-indexes' ? searchModelOf([])(call) : rows(call));

  it('adds up what both runs left out, by reason, and makes the sentences from the totals', async () => {
    const { answer } = await searched([], {}, respond);
    expect(answer.dropped).toEqual({ 'not-mapped': 2, 'ambiguous-type': 0, 'no-stable-id': 1 });
    expect(answer.warnings).toEqual(warningsOf({ 'not-mapped': 2, 'ambiguous-type': 0, 'no-stable-id': 1 }));
    expect(answer.warnings).toHaveLength(2);
  });

  it('leaves out the overflow row of a capped read, which the gate cuts before normalization', async () => {
    const many = (call: ExecuteCall): Promise<ExecuteOutcome> =>
      call.templateId === 'entity-related'
        ? Promise.resolve(entityRows(...[...Array.from({ length: 25 }, (_, index) => plainNode(['Gadget'], { gadgetId: `GT-${index + 1}`, widgetRef: TEXT }, `4:g:${index + 1}`)), plainNode(['Nothing'], { x: 1 }, '4:over:1')]))
        : Promise.resolve(entityRows());
    const { answer } = await searched([], {}, (call) => (call.templateId === 'schema-indexes' ? searchModelOf([])(call) : many(call)));
    expect(answer.related.count).toEqual({ value: 25, quality: 'lowerBound', scope: 'search:related' });
    expect(answer.dropped).toEqual({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });
    expect(answer.warnings).toEqual([]);
  });

  it('adds nothing for a group that made no read', async () => {
    const plain = searchMappingOf();
    const app = await startSearchApp({ mapping: plain, respond: (call) => (call.templateId === 'schema-indexes' ? searchModelOf([])(call) : rows(call)) });
    const answer = searchResultSchema.parse((await postSearch(app.app, { sourceId: 'demo', text: TEXT })).json());
    expect(answer.dropped).toEqual({ 'not-mapped': 1, 'ambiguous-type': 0, 'no-stable-id': 0 });
    expect(relatedCalls(app.executor)).toEqual([]);
    await app.app.close();
  });
});
