import { FACET_SCOPES, searchResultSchema, type SearchResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { evidenceCalls, facetCalls, postSearch, relatedCalls, searchCalls, searchMappingOf, startSearchApp, type SearchAppOptions } from '../testing/search-app.js';
import { searchModelOf, type StoredNode, type StoredRelationship } from '../testing/search-fixtures.js';

const TEXT = 'X-1';
const ENTITIES = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['widgetId', 'ownerName'], reference: ['batchRef'] },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['gadgetId', 'region'], reference: ['widgetRef'] },
  { type: 'part', label: 'Part', stable_id: 'partId' },
];
const RELATIONSHIPS = [{ type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId'] }];

const widgets = (count: number, properties: Record<string, unknown> = { ownerName: TEXT }): StoredNode[] =>
  Array.from({ length: count }, (_, index) => ({ elementId: `4:w:${index + 1}`, label: 'Widget', properties: { widgetId: `W-${String(index + 1).padStart(3, '0')}`, ...properties } }));
const gadgets = (count: number, properties: Record<string, unknown> = { region: TEXT }): StoredNode[] =>
  Array.from({ length: count }, (_, index) => ({ elementId: `4:g:${index + 1}`, label: 'Gadget', properties: { gadgetId: `GT-${String(index + 1).padStart(3, '0')}`, ...properties } }));
const anchor = { from: { elementId: '4:w:900', label: 'Widget', properties: { widgetId: 'W-900' } }, to: { elementId: '4:g:900', label: 'Gadget', properties: { gadgetId: 'GT-900' } } };
const linked = (count: number): StoredRelationship[] => Array.from({ length: count }, (_, index) => ({ elementId: `5:r:${index + 1}`, type: 'MADE_FROM', from: anchor.from, to: anchor.to, properties: { linkId: `L-${index + 1}`, recordId: TEXT } }));

async function searched(stored: readonly StoredNode[], request: Record<string, unknown> = {}, options: SearchAppOptions = {}, relationships: readonly StoredRelationship[] = []) {
  const mapping = searchMappingOf({ entities: ENTITIES, relationships: RELATIONSHIPS });
  const parts = await startSearchApp({ mapping, respond: searchModelOf([...stored, anchor.from, anchor.to], () => undefined, relationships), ...options });
  const response = await postSearch(parts.app, { sourceId: 'demo', text: TEXT, ...request });
  const answer: SearchResult | undefined = response.statusCode === 200 ? searchResultSchema.parse(response.json()) : undefined;
  return { response, answer, parts };
}

const failing =
  (failures: Readonly<Record<string, ExecuteOutcome | Error>>, model = searchModelOf([...widgets(2), ...gadgets(2), anchor.from, anchor.to], () => undefined, linked(2))) =>
  (call: ExecuteCall): Promise<ExecuteOutcome> => {
    const failure = failures[call.templateId];
    if (failure === undefined) return model(call);
    return failure instanceof Error ? Promise.reject(failure) : Promise.resolve(failure);
  };

describe('a selection of entity types', () => {
  it('narrows the exact and the related group to those types, with the capped count of the whole type and not of the page, and leaves the evidence group alone', async () => {
    const stored = [...widgets(30), ...gadgets(5), ...widgets(0)];
    const unselected = await searched(stored, {}, {}, linked(3));
    const selected = await searched(stored, { entityTypes: ['widget'] }, {}, linked(3));
    expect(selected.answer?.exact.every((node) => node.ref.entityType === 'widget')).toBe(true);
    expect(selected.answer?.counts.exact).toEqual({ value: 25, quality: 'lowerBound', scope: 'search:exact' });
    expect(selected.answer?.exact).toHaveLength(25);
    expect(selected.answer?.evidence.count).toEqual({ value: 3, quality: 'exact', scope: 'search:evidence' });
    expect(selected.answer?.filters).toEqual({ entityTypes: ['widget'], matchModes: [] });
    expect(searchCalls(selected.parts.executor)[0]?.cypher).toContain('Widget');
    expect(searchCalls(selected.parts.executor)[0]?.cypher).not.toContain('Gadget');
    expect(unselected.answer?.counts.exact).toEqual({ value: 25, quality: 'lowerBound', scope: 'search:exact' });
    expect(unselected.answer?.facets).toEqual(selected.answer?.facets);
    await unselected.parts.app.close();
    await selected.parts.app.close();
  });

  it('leaves every facet count and the total as the unselected search gives them', async () => {
    const stored = [...widgets(30), ...gadgets(5)];
    const unselected = await searched(stored);
    const selected = await searched(stored, { entityTypes: ['gadget'] });
    const both = await searched(stored, { entityTypes: ['gadget'], matchModes: ['exact'] });
    expect(selected.answer?.facets).toEqual(unselected.answer?.facets);
    expect(both.answer?.facets).toEqual(unselected.answer?.facets);
    expect(selected.answer?.facets).toMatchObject({ searchable: true, entityType: [{ entityType: 'widget', count: { value: 25, quality: 'lowerBound' } }, { entityType: 'gadget', count: { value: 5, quality: 'exact', scope: FACET_SCOPES.entityType } }] });
    expect(selected.answer?.exact.every((node) => node.ref.entityType === 'gadget')).toBe(true);
    for (const run of [unselected, selected, both]) await run.parts.app.close();
  });

  it('keeps the exact count of a selected type at 24, 25 and 26', async () => {
    for (const [matches, quality, value] of [[24, 'exact', 24], [25, 'exact', 25], [26, 'lowerBound', 25]] as const) {
      const { answer, parts } = await searched([...widgets(matches), ...gadgets(40)], { entityTypes: ['widget'] });
      expect(answer?.counts.exact).toEqual({ value, quality, scope: 'search:exact' });
      await parts.app.close();
    }
  });

  it('accepts a valid type that has no target for a group, and says that group has nothing to search', async () => {
    const { answer, parts } = await searched([...widgets(2)], { entityTypes: ['part'] });
    expect(answer?.searchable).toBe(false);
    expect(answer?.related.searchable).toBe(false);
    expect(answer?.evidence.searchable).toBe(true);
    expect(answer?.filters).toEqual({ entityTypes: ['part'], matchModes: [] });
    expect(searchCalls(parts.executor)).toEqual([]);
    expect(relatedCalls(parts.executor)).toEqual([]);
    await parts.app.close();
  });

  it('keeps the types in the order of the mapping and each once, however the request lists them', async () => {
    const { answer, parts } = await searched([...widgets(1), ...gadgets(1)], { entityTypes: ['gadget', 'widget'] });
    expect(answer?.filters?.entityTypes).toEqual(['widget', 'gadget']);
    await parts.app.close();
  });
});

describe('a selection of match modes', () => {
  it('reads only the chosen group: no statement, no read of the seam and no audit event for the others, which are not searched, empty, known and not failed', async () => {
    let acquired = 0;
    const coordinator = { acquireRead: () => (acquired += 1, Promise.resolve({ status: 'granted' as const, lease: { release: () => Promise.resolve() } })) };
    const { answer, parts } = await searched([...widgets(2), ...gadgets(2)], { matchModes: ['related'] }, { coordinator }, linked(2));
    expect(searchCalls(parts.executor)).toEqual([]);
    expect(evidenceCalls(parts.executor)).toEqual([]);
    expect(relatedCalls(parts.executor)).toHaveLength(1);
    expect(acquired).toBe(3);
    expect(parts.events.map((event) => event.action).sort()).toEqual(['entity.search_facets', 'entity.search_related', 'source.schema_indexes']);
    expect(answer?.searchable).toBe(false);
    expect(answer?.exact).toEqual([]);
    expect(answer?.counts.exact).toEqual({ value: 0, quality: 'exact', scope: 'search:exact' });
    expect(answer?.evidence).toMatchObject({ hits: [], searchable: false, count: { value: 0, quality: 'exact' } });
    expect(answer?.failures).toEqual([]);
    expect(answer?.filters).toEqual({ entityTypes: [], matchModes: ['related'] });
    expect(answer?.facets).toMatchObject({ searchable: true, matchMode: [{ mode: 'exact' }, { mode: 'related' }, { mode: 'evidence' }] });
    await parts.app.close();
  });

  it('reads the groups of both chosen modes and none other, with both lists narrowing together', async () => {
    const { answer, parts } = await searched([...widgets(2), ...gadgets(2)], { matchModes: ['exact', 'evidence'], entityTypes: ['gadget'] }, {}, linked(2));
    expect(searchCalls(parts.executor)).toHaveLength(1);
    expect(relatedCalls(parts.executor)).toEqual([]);
    expect(evidenceCalls(parts.executor)).toHaveLength(1);
    expect(answer?.exact.every((node) => node.ref.entityType === 'gadget')).toBe(true);
    expect(answer?.evidence.hits).toHaveLength(2);
    await parts.app.close();
  });

  it('reads the first chosen group with a target alone first, and the others and the facet read after it', async () => {
    const { parts } = await searched([...widgets(2), ...gadgets(2)], { matchModes: ['related', 'evidence'] }, {}, linked(2));
    const order = parts.executor.calls.map((call) => call.templateId).filter((id) => id !== 'schema-indexes');
    expect(order[0]).toBe('entity-related');
    expect(order.slice(1).sort()).toEqual(['relationship-evidence', 'search-facets']);
    await parts.app.close();
  });

  it('stops after the first read when it fails with an error that means the same for every group', async () => {
    const respond = failing({ 'entity-related': { status: 'unavailable', reason: 'unreachable' } });
    const { response, parts } = await searched([], { matchModes: ['related', 'evidence'] }, { respond });
    expect(response.statusCode).toBe(503);
    expect(evidenceCalls(parts.executor)).toEqual([]);
    expect(facetCalls(parts.executor)).toEqual([]);
    await parts.app.close();
  });

  it('names a first read that fails with a code of its own and goes on with the others', async () => {
    const respond = failing({ 'entity-related': { status: 'timeout' } });
    const { answer, parts } = await searched([], { matchModes: ['related', 'evidence'] }, { respond });
    expect(answer?.failures).toEqual([{ group: 'related', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }]);
    expect(answer?.evidence.hits.length).toBeGreaterThan(0);
    await parts.app.close();
  });
});

describe('a selection that leaves the groups nothing to read', () => {
  it('still reads the facets from the unselected targets, and a failed facet read is the only failure', async () => {
    const respond = failing({ 'search-facets': { status: 'timeout' } });
    const { response, answer, parts } = await searched([], { entityTypes: ['part'], matchModes: ['related'] }, { respond });
    expect(response.statusCode).toBe(200);
    expect(answer?.failures).toEqual([{ group: 'facets', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }]);
    expect(answer?.searchable).toBe(false);
    expect(searchCalls(parts.executor)).toEqual([]);
    expect(relatedCalls(parts.executor)).toEqual([]);
    expect(evidenceCalls(parts.executor)).toEqual([]);
    expect(facetCalls(parts.executor)).toHaveLength(1);
    await parts.app.close();
  });

  it('sends the exact group through the gate with every stage but the read when it is chosen and has no target for the selected types', async () => {
    const { answer, parts } = await searched([...widgets(2)], { entityTypes: ['part'], matchModes: ['exact'] });
    expect(answer?.searchable).toBe(false);
    expect(searchCalls(parts.executor)).toEqual([]);
    expect(parts.events.map((event) => `${event.action} ${event.result}`)).toContain('entity.search success');
    await parts.app.close();
  });
});

describe('a selection the search refuses', () => {
  it.each([
    ['an entity type the mapping does not name', { entityTypes: ['no-such-type'] }],
    ['an entity type of another source', { entityTypes: ['widget', 'type-of-another-source'] }],
    ['an entity type with a backtick', { entityTypes: ['widget` OR 1=1 //'] }],
    ['an unknown match mode', { matchModes: ['startsWith'] }],
    ['an empty list of entity types', { entityTypes: [] }],
    ['an empty list of match modes', { matchModes: [] }],
    ['an entity type chosen twice', { entityTypes: ['widget', 'widget'] }],
    ['a match mode chosen twice', { matchModes: ['exact', 'exact'] }],
    ['a selection with type-ahead', { typeahead: true, entityTypes: ['widget'] }],
    ['a mode selection with type-ahead', { typeahead: true, matchModes: ['exact'] }],
    ['a selection that is not a list', { entityTypes: 'widget' }],
  ])('answers INVALID_REQUEST for %s with no read, and not the typed text', async (_name, request) => {
    const { response, parts } = await searched([...widgets(1)], { text: 'secret-text-77', ...request });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(JSON.stringify(response.json())).not.toContain('secret-text-77');
    expect(parts.executor.calls).toEqual([]);
    expect(parts.lines.join('\n')).not.toContain('secret-text-77');
    await parts.app.close();
  });
});

describe('no selection', () => {
  it('answers filters with two empty lists and the answer of the search without them', async () => {
    const { answer, parts } = await searched([...widgets(2), ...gadgets(1)]);
    expect(answer?.filters).toEqual({ entityTypes: [], matchModes: [] });
    expect(answer?.exact).toHaveLength(3);
    await parts.app.close();
  });

  it('gives a type-ahead answer no filters, and reads the exact group and then startsWith as before, a startsWith failure naming only that group', async () => {
    const respond = failing({ 'entity-search-prefix': { status: 'timeout' } });
    const { answer, parts } = await searched([...widgets(2)], { typeahead: true, text: 'X-' }, { respond });
    expect(answer?.filters).toBeUndefined();
    expect(answer?.facets).toBeUndefined();
    expect(answer?.failures).toEqual([{ group: 'startsWith', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }]);
    expect(parts.executor.calls.map((call) => call.templateId)).toEqual(['schema-indexes', 'entity-search', 'entity-search-prefix']);
    await parts.app.close();
  });
});

describe('a schema read that fails when the selection leaves no group a first read', () => {
  const TIMEOUT: ExecuteOutcome = { status: 'timeout' };
  const schemaFailing = (outcome: ExecuteOutcome | Error) => (call: ExecuteCall): Promise<ExecuteOutcome> =>
    call.templateId === 'schema-indexes' ? (outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)) : failing({})(call);
  const SELECTIONS: readonly (readonly [string, Record<string, unknown>])[] = [
    ['a mode with no target for the source', { matchModes: ['related'], entityTypes: ['part'] }],
    ['a chosen exact group and a type with no search property', { matchModes: ['exact'], entityTypes: ['part'] }],
  ];

  it.each(SELECTIONS.flatMap(([name, request]) => [
    [name, request, 'a timeout', TIMEOUT, 504, 'QUERY_TIMEOUT'],
    [name, request, 'a busy source', new AppError('SOURCE_BUSY'), 503, 'SOURCE_BUSY'],
  ]))('fails the search with the code of the schema read, runs no data read and answers no facets failure, for %s and %s', async (_name, request, _failure, outcome, status, code) => {
    const { response, parts } = await searched([...widgets(1)], request, { ownSchema: true, respond: schemaFailing(outcome) });
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(response.json()).not.toHaveProperty('failures');
    expect(parts.executor.calls.filter((call) => call.templateId !== 'schema-indexes')).toEqual([]);
    await parts.app.close();
  });
});
