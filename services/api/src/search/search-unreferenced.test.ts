import { searchMoreResultSchema, searchResultSchema, type SearchMoreResult, type SearchResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { postMore, postSearch, searchMappingOf, startSearchApp, type SearchApp } from '../testing/search-app.js';
import { searchModelOf, type StoredNode } from '../testing/search-fixtures.js';

const TEXT = 'needle';
const ENTITIES = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', title: '{nickname} {ownerName}', search: ['nickname', 'ownerName'], reference: ['batchRef'], pii: [{ property: 'ownerName', class: 'name' }] },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['region'] },
];
const mapping = searchMappingOf({ entities: ENTITIES, relationships: [] });

/** The stable IDs a record cannot be referenced by: missing, empty, a float, an integer beyond the safe range, and a value of another type. */
const UNUSABLE: readonly (readonly [string, Record<string, unknown>])[] = [
  ['missing', {}],
  ['empty', { widgetId: '' }],
  ['a float', { widgetId: { $type: 'float', value: '7.0' } }],
  ['a fraction', { widgetId: 7.5 }],
  ['a non-safe integer', { widgetId: 2 ** 60 }],
  ['of another type', { widgetId: ['W-1'] }],
];

const ELEMENT_ID = (index: number): string => `4:secret-element:${String(index).padStart(3, '0')}`;
const record = (index: number, stableId: Record<string, unknown>): StoredNode => ({
  elementId: ELEMENT_ID(index),
  label: 'Widget',
  properties: { nickname: TEXT, batchRef: TEXT, ownerName: `Owner ${index}`, ...stableId },
});

const started = (stored: readonly StoredNode[]): Promise<SearchApp> => startSearchApp({ mapping, respond: searchModelOf(stored) });

async function search(app: SearchApp['app'], extra: Record<string, unknown> = {}): Promise<SearchResult> {
  const response = await postSearch(app, { sourceId: 'demo', text: TEXT, ...extra });
  expect(response.statusCode).toBe(200);
  return searchResultSchema.parse(response.json());
}

async function more(app: SearchApp['app'], body: Record<string, unknown>): Promise<SearchMoreResult> {
  const response = await postMore(app, { sourceId: 'demo', text: TEXT, ...body });
  expect(response.statusCode).toBe(200);
  return searchMoreResultSchema.parse(response.json());
}

describe('a search hit whose stable ID cannot be used', () => {
  it.each(UNUSABLE)('is an unreferenced hit of its group when the stable ID is %s, counted, and its number is the no-stable-id drop count', async (_name, stableId) => {
    const { app } = await started([record(1, stableId), record(2, { widgetId: 'W-2' })]);
    const answer = await search(app);
    expect(answer.exact.map((node) => node.ref.stableId)).toEqual(['W-2']);
    expect(answer.exactUnreferenced).toEqual([{ entityType: 'widget', title: `${TEXT} Owner 1`, properties: expect.any(Array), reason: 'no-stable-id' }]);
    expect(answer.counts.exact).toEqual({ value: 2, quality: 'exact', scope: 'search:exact' });
    expect(answer.related.unreferenced).toHaveLength(1);
    expect(answer.related.count).toMatchObject({ value: 2, quality: 'exact' });
    expect(answer.dropped['no-stable-id']).toBe(2);
    expect(answer.warnings).toEqual(['2 rows have no usable stable ID, so they are listed and cannot be opened or added.']);
    await app.close();
  });

  it('is listed in the startsWith group of a type-ahead search too', async () => {
    const stored: StoredNode[] = [{ elementId: ELEMENT_ID(1), label: 'Widget', properties: { nickname: `${TEXT}-longer`, ownerName: 'Owner 1' } }];
    const { app } = await started(stored);
    const answer = await search(app, { typeahead: true });
    expect(answer.startsWith?.unreferenced).toEqual([expect.objectContaining({ entityType: 'widget', reason: 'no-stable-id' })]);
    expect(answer.startsWith?.count).toMatchObject({ value: 1, quality: 'exact' });
    expect(answer.startsWith?.dropped['no-stable-id']).toBe(1);
    await app.close();
  });

  it('has its personal-data properties and its title masked as a node is, when the search asks for masking', async () => {
    const { app } = await started([record(1, {})]);
    const answer = await search(app, { mask: true });
    const [hit] = answer.exactUnreferenced ?? [];
    const owner = hit?.properties.find((property) => property.key === 'ownerName');
    expect(owner).toMatchObject({ masked: true, maskedBy: 'request' });
    expect(owner?.value).not.toBe('Owner 1');
    expect(hit?.title).not.toContain('Owner 1');
    expect(JSON.stringify(answer)).not.toContain('Owner 1');
    await app.close();
  });

  it('holds no reference, no cursor and no element ID in any of its fields, and no reference is made from an element ID', async () => {
    const stored = UNUSABLE.map(([, stableId], index) => record(index + 1, stableId));
    const { app } = await started(stored);
    const answer = await search(app);
    const hits = [...(answer.exactUnreferenced ?? []), ...(answer.related.unreferenced ?? [])];
    expect(hits).toHaveLength(UNUSABLE.length * 2);
    for (const hit of hits) {
      expect(Object.keys(hit).sort()).toEqual(['entityType', 'properties', 'reason', 'title']);
      expect(JSON.stringify(hit)).not.toMatch(/secret-element/);
    }
    expect(answer.exact).toEqual([]);
    expect(answer.related.hits).toEqual([]);
    expect(JSON.stringify(answer)).not.toMatch(/secret-element/);
    await app.close();
  });
});

describe('unreferenced hits over several pages', () => {
  const MATCHES = 30;
  // every third record has no usable stable ID; the element IDs give the order the pages are read in
  const stored = Array.from({ length: MATCHES }, (_, index) => record(index, index % 3 === 0 ? {} : { widgetId: `W-${index}` }));
  const unreferenced = stored.filter((_node, index) => index % 3 === 0).length;

  it('are paged with the other hits in element ID order, each on the page it falls on, none twice and none skipped', async () => {
    const { app } = await started(stored);
    const first = await search(app, { matchModes: ['exact'] });
    const firstShown = first.exact.length + (first.exactUnreferenced?.length ?? 0);
    expect(firstShown).toBe(25);
    expect(first.counts.exact).toMatchObject({ value: 25, quality: 'lowerBound' });
    // the first 25 rows in element ID order are records 0 to 24, of which 0, 3, ..., 24 are unreferenced
    expect(first.exactUnreferenced).toHaveLength(9);
    expect(first.dropped['no-stable-id']).toBe(9);
    const second = await more(app, { group: 'exact', cursor: first.exactNextCursor });
    if (second.group !== 'exact') throw new Error('the page is not of the exact group');
    expect(second.nodes.map((node) => node.ref.stableId)).toEqual(['W-25', 'W-26', 'W-28', 'W-29']);
    expect(second.unreferenced).toHaveLength(1);
    expect(second.count).toEqual({ value: MATCHES, quality: 'exact', scope: 'search:exact' });
    expect(second.dropped['no-stable-id']).toBe(1);
    expect(second.nextCursor).toBeUndefined();
    expect((first.exactUnreferenced?.length ?? 0) + (second.unreferenced?.length ?? 0)).toBe(unreferenced);
    expect(first.exact.length + second.nodes.length).toBe(MATCHES - unreferenced);
    expect(JSON.stringify([first.exactUnreferenced, second.unreferenced])).not.toMatch(/secret-element/);
    await app.close();
  });

  it('are on the related group\'s next page too', async () => {
    const { app } = await started(stored);
    const first = await search(app, { matchModes: ['related'] });
    expect(first.related.unreferenced).toHaveLength(9);
    const second = await more(app, { group: 'related', cursor: first.related.nextCursor });
    if (second.group !== 'related') throw new Error('the page is not of the related group');
    expect(second.unreferenced).toHaveLength(1);
    expect(second.count).toMatchObject({ value: MATCHES, quality: 'exact' });
    await app.close();
  });
});
