import { FACET_SCOPES, searchResultSchema, type SearchResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { facetCalls, postSearch, searchCalls, searchMappingOf, startSearchApp } from '../testing/search-app.js';
import { facetRowOf, searchModelOf, type StoredNode } from '../testing/search-fixtures.js';

const TEXT = 'X-1';
const ENTITIES = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['widgetId', 'ownerName', 'nickname'] },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['gadgetId', 'region'] },
  { type: 'part', label: 'Part', stable_id: 'partId' },
];

const widgets = (count: number, property = 'ownerName'): StoredNode[] =>
  Array.from({ length: count }, (_, index) => ({ elementId: `4:w:${index + 1}`, label: 'Widget', properties: { widgetId: `W-${String(index + 1).padStart(3, '0')}`, [property]: TEXT } }));
const gadgets = (count: number): StoredNode[] => Array.from({ length: count }, (_, index) => ({ elementId: `4:g:${index + 1}`, label: 'Gadget', properties: { gadgetId: `GT-${String(index + 1).padStart(3, '0')}`, region: TEXT } }));

async function searched(stored: readonly StoredNode[], overrides: Record<string, unknown> = {}, options: Parameters<typeof startSearchApp>[0] = {}, request: Record<string, unknown> = {}) {
  const mapping = searchMappingOf({ entities: ENTITIES, ...overrides });
  const parts = await startSearchApp({ mapping, respond: searchModelOf(stored), ...options });
  const response = await postSearch(parts.app, { sourceId: 'demo', text: TEXT, ...request });
  return { response, parts, answer: response.statusCode === 200 ? searchResultSchema.parse(response.json()) : undefined };
}

const searchable = (answer: SearchResult | undefined) => {
  if (answer?.facets === undefined || !answer.facets.searchable) throw new Error('the answer has no facets');
  return answer.facets;
};

describe('the facets of a search answer', () => {
  it('counts the entities of each entity type, the exact matches and the total, each exact with the scope of its facet', async () => {
    const { answer, parts } = await searched([...widgets(3), ...gadgets(2)]);
    const facets = searchable(answer);
    expect(facets.entityType).toEqual([
      { entityType: 'widget', count: { value: 3, quality: 'exact', scope: FACET_SCOPES.entityType } },
      { entityType: 'gadget', count: { value: 2, quality: 'exact', scope: FACET_SCOPES.entityType } },
    ]);
    expect(facets.matchMode).toEqual([{ mode: 'exact', count: { value: 5, quality: 'exact', scope: FACET_SCOPES.matchMode } }]);
    expect(facets.total).toEqual({ value: 5, quality: 'exact', scope: FACET_SCOPES.total });
    expect(answer?.filters).toEqual({ entityTypes: [], matchModes: [] });
    await parts.app.close();
  });

  it('leaves the exact group and its count as they were', async () => {
    const { answer, parts } = await searched([...widgets(3), ...gadgets(2)]);
    expect(answer?.exact).toHaveLength(5);
    expect(answer?.counts.exact).toEqual({ value: 5, quality: 'exact', scope: 'search:exact' });
    await parts.app.close();
  });

  it('gives an entity type that nothing matches an entry of 0, and a type with no search property no entry', async () => {
    const { answer, parts } = await searched(widgets(2));
    const facets = searchable(answer);
    expect(facets.entityType.map((entry) => [entry.entityType, entry.count])).toEqual([
      ['widget', { value: 2, quality: 'exact', scope: FACET_SCOPES.entityType }],
      ['gadget', { value: 0, quality: 'exact', scope: FACET_SCOPES.entityType }],
    ]);
    await parts.app.close();
  });

  it.each([
    [39, 'exact', 39],
    [40, 'exact', 40],
    [41, 'lowerBound', 40],
  ])('counts %i matches as %s with the value %i for a source whose count cap is 40, past the page of 25', async (matches, quality, value) => {
    const { answer, parts } = await searched(widgets(matches), { budgets: { heavy_op_threshold: 40 } });
    const facets = searchable(answer);
    expect(facets.entityType[0]?.count).toEqual({ value, quality, scope: FACET_SCOPES.entityType });
    expect(facets.matchMode[0]?.count).toEqual({ value, quality, scope: FACET_SCOPES.matchMode });
    expect(facets.total).toEqual({ value, quality, scope: FACET_SCOPES.total });
    expect(facetCalls(parts.executor)[0]?.parameters['countCap']).toBe(40);
    expect(answer?.counts.exact).toEqual({ value: 25, quality: 'lowerBound', scope: 'search:exact' });
    await parts.app.close();
  });

  it('counts past the page of a source whose max_page is 10, up to the count cap', async () => {
    const { answer, parts } = await searched(widgets(11), { budgets: { max_page: 10, default_page: 10 } });
    expect(searchable(answer).total).toEqual({ value: 11, quality: 'exact', scope: FACET_SCOPES.total });
    expect(answer?.counts.exact).toEqual({ value: 10, quality: 'lowerBound', scope: 'search:exact' });
    expect(facetCalls(parts.executor)[0]?.parameters['countCap']).toBe(500);
    await parts.app.close();
  });

  it('counts at the default count cap of 500 as exact, and above it as a lower bound of 500', async () => {
    for (const [matches, quality, value] of [[500, 'exact', 500], [501, 'lowerBound', 500]] as const) {
      const { answer, parts } = await searched(widgets(matches));
      expect(searchable(answer).total).toEqual({ value, quality, scope: FACET_SCOPES.total });
      await parts.app.close();
    }
  });

  it('shows a lower-bound facet as at least the hits its group holds when the count cap is below the page', async () => {
    const { answer, parts } = await searched(widgets(30), { budgets: { heavy_op_threshold: 10 } });
    expect(answer?.exact).toHaveLength(25);
    expect(searchable(answer).total).toEqual({ value: 25, quality: 'lowerBound', scope: FACET_SCOPES.total });
    expect(searchable(answer).matchMode[0]?.count).toEqual({ value: 25, quality: 'lowerBound', scope: FACET_SCOPES.matchMode });
    await parts.app.close();
  });

  it('never answers an exact facet lower than the hits its group holds, when the source changed between the two reads', async () => {
    const stored = widgets(3);
    const model = searchModelOf(stored);
    const { answer, parts } = await searched(stored, {}, { respond: (call) => (call.templateId === 'search-facets' ? Promise.resolve(facetRowOf(call, 1)) : model(call)) });
    expect(answer?.exact).toHaveLength(3);
    expect(searchable(answer).total).toEqual({ value: 3, quality: 'lowerBound', scope: FACET_SCOPES.total });
    expect(searchable(answer).entityType[0]?.count).toEqual({ value: 3, quality: 'lowerBound', scope: FACET_SCOPES.entityType });
    await parts.app.close();
  });

  it('counts a node that two search properties match once, and a node that carries two mapped labels in each type it carries', async () => {
    const both: StoredNode = { elementId: '4:w:1', label: 'Widget', properties: { widgetId: 'W-001', ownerName: TEXT, nickname: TEXT } };
    const twoLabels: StoredNode = { elementId: '4:x:1', label: 'Widget', alsoLabels: ['Gadget'], properties: { widgetId: 'W-002', gadgetId: 'GT-002', ownerName: TEXT, region: TEXT } };
    const { answer, parts } = await searched([both, twoLabels]);
    const facets = searchable(answer);
    expect(facets.entityType.map((entry) => [entry.entityType, entry.count])).toEqual([
      ['widget', { value: 2, quality: 'exact', scope: FACET_SCOPES.entityType }],
      ['gadget', { value: 1, quality: 'exact', scope: FACET_SCOPES.entityType }],
    ]);
    // the read counts two nodes; the group holds three hits (the second node as each of its types), so neither count is shown below the hits held
    expect(facets.matchMode[0]?.count).toEqual({ value: 3, quality: 'lowerBound', scope: FACET_SCOPES.matchMode });
    expect(facets.total).toEqual({ value: 3, quality: 'lowerBound', scope: FACET_SCOPES.total });
    await parts.app.close();
  });
});

describe('the read of the facets', () => {
  it('costs one read of the seam, beside the schema read and the exact read, and releases each', async () => {
    let acquired = 0;
    let released = 0;
    const coordinator = { acquireRead: () => (acquired += 1, Promise.resolve({ status: 'granted' as const, lease: { release: () => (released += 1, Promise.resolve()) } })) };
    const { parts } = await searched(widgets(2), {}, { coordinator });
    expect(parts.executor.calls.map((call) => call.templateId).sort()).toEqual(['entity-search', 'schema-indexes', 'search-facets']);
    expect(facetCalls(parts.executor)).toHaveLength(1);
    expect(acquired).toBe(3);
    expect(released).toBe(3);
    await parts.app.close();
  });

  it('reads nothing for a source with no search property, says so, and makes no facet read or event', async () => {
    const { answer, parts } = await searched([], { entities: [{ type: 'part', label: 'Part', stable_id: 'partId' }] });
    expect(answer?.facets).toEqual({ searchable: false });
    expect(facetCalls(parts.executor)).toEqual([]);
    expect(parts.events.map((event) => event.action)).toEqual(['entity.search']);
    await parts.app.close();
  });

  it('is one audit event with its own action and its own result, and no event, log line or answer field holds the typed text', async () => {
    const { response, parts } = await searched(widgets(2));
    expect(parts.events.map((event) => `${event.action} ${event.result}`).sort()).toEqual(['entity.search success', 'entity.search_facets success', 'source.schema_indexes success']);
    expect(JSON.stringify(parts.events)).not.toContain(TEXT);
    expect(parts.lines.join('\n')).not.toContain(TEXT);
    expect(JSON.stringify(searchResultSchema.parse(response.json()).facets)).not.toContain(TEXT);
    await parts.app.close();
  });

  it('is the same read for the same text whatever the groups find: the statement does not change with the data', async () => {
    const first = await searched(widgets(1));
    const second = await searched([...widgets(20), ...gadgets(20)]);
    expect(facetCalls(first.parts.executor)[0]?.cypher).toBe(facetCalls(second.parts.executor)[0]?.cypher);
    await first.parts.app.close();
    await second.parts.app.close();
  });

  it('treats a count it cannot read as a failure of the facet read only, with no value in the answer and the groups kept', async () => {
    const { response, answer, parts } = await searched([], {}, { respond: (call) => Promise.resolve(call.templateId === 'search-facets' ? { status: 'rows' as const, rows: [{ c0: -1, c1: 0, c2: 0, c3: 0 }] } : searchModelOf(widgets(1))(call)) });
    expect(response.statusCode).toBe(200);
    expect(answer?.failures).toEqual([{ group: 'facets', code: 'INTERNAL_ERROR' }]);
    expect(answer?.exact).toHaveLength(1);
    expect(JSON.stringify(answer?.facets)).not.toContain('-1');
    await parts.app.close();
  });

  it('treats a facet read that answered no row as a failure of that read only', async () => {
    const { answer, parts } = await searched([], {}, { respond: (call) => (call.templateId === 'search-facets' ? Promise.resolve({ status: 'rows' as const, rows: [] }) : searchModelOf(widgets(1))(call)) });
    expect(answer?.failures).toEqual([{ group: 'facets', code: 'INTERNAL_ERROR' }]);
    expect(answer?.facets).toEqual({ searchable: true, total: { quality: 'unknown', scope: FACET_SCOPES.total }, entityType: [], matchMode: [] });
    await parts.app.close();
  });
});

describe('a type-ahead request', () => {
  it('reads no facets and answers neither facets nor filters', async () => {
    const { answer, parts } = await searched(widgets(2), {}, {}, { typeahead: true });
    expect(answer?.facets).toBeUndefined();
    expect(answer?.filters).toBeUndefined();
    expect(facetCalls(parts.executor)).toEqual([]);
    expect(searchCalls(parts.executor).length).toBeGreaterThan(0);
    expect(answer?.startsWith).toBeDefined();
    await parts.app.close();
  });
});

describe('the helper that answers a facet read for tests', () => {
  it('gives every probe the same count, at most the count cap plus one', () => {
    const call = { cypher: 'CALL { }\nRETURN c0, c1', rowLimit: 5, parameters: { countCap: 4 } } as never;
    expect(facetRowOf(call, 9)).toEqual({ status: 'rows', rows: [{ c0: 5, c1: 5 }] });
  });
});
