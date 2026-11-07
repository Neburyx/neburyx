import { searchResultSchema, type SearchResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ExecuteCall } from '../gate/executor.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { postSearch, searchMappingOf, startSearchApp, type SearchAppOptions } from '../testing/search-app.js';
import { rangeIndex, schemaAnswer, searchModelOf, withSchema, type IndexRow, type StoredNode } from '../testing/search-fixtures.js';

const ALL_ONLINE: readonly IndexRow[] = [rangeIndex('Widget', 'widgetId', 'ONLINE', true), rangeIndex('Widget', 'ownerName'), rangeIndex('Gadget', 'gadgetId')];

const stored = (label: string, properties: Record<string, unknown>, number: number): StoredNode => ({ elementId: `4:s:${number}`, label, properties });
const widgetsWith = (prefix: string, count: number, firstNumber = 1): StoredNode[] => Array.from({ length: count }, (_, index) => stored('Widget', { widgetId: `${prefix}${String(index + 1).padStart(3, '0')}` }, firstNumber + index));

function started(nodes: readonly StoredNode[], options: SearchAppOptions = {}, indexes: () => ReturnType<typeof schemaAnswer> = () => schemaAnswer(ALL_ONLINE)) {
  return startSearchApp({ ...options, ownSchema: true, respond: withSchema(indexes, searchModelOf(nodes)) });
}

const typeahead = (text: string, extra: Record<string, unknown> = {}) => ({ sourceId: 'demo', text, typeahead: true, ...extra });
const ids = (calls: readonly ExecuteCall[]): string[] => calls.map((call) => call.templateId);
const resultOf = (response: { json(): unknown }): SearchResult => searchResultSchema.parse(response.json());
const stableIds = (nodes: readonly { readonly ref: { readonly stableId: string } }[]): string[] => nodes.map((node) => node.ref.stableId);

describe('the typed text bounds of a type-ahead request', () => {
  it.each([
    ['one character', 'A'],
    ['an empty text', ''],
    ['201 characters', 'A'.repeat(201)],
    ['201 code points outside the basic plane', '😀'.repeat(201)],
    ['one code point outside the basic plane', '😀'],
  ])('refuses %s with INVALID_REQUEST and reads nothing, not even the schema', async (_name, text) => {
    const { app, executor, events } = await started([]);
    const response = await postSearch(app, typeahead(text));
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(executor.calls).toEqual([]);
    expect(events).toEqual([]);
    await app.close();
  });

  it.each([['AB'], ['😀😀'], ['A'.repeat(200)], ['😀'.repeat(200)]])('accepts %s', async (text) => {
    const { app } = await started([]);
    expect((await postSearch(app, typeahead(text))).statusCode).toBe(200);
    await app.close();
  });
});

describe('a request that does not ask for type-ahead', () => {
  it.each([[{}], [{ typeahead: false }]])('answers as an exact search with no startsWith, makes no prefix read, and accepts one character (%j)', async (flag) => {
    const { app, executor } = await started(widgetsWith('W-', 3));
    const response = await postSearch(app, { sourceId: 'demo', text: 'W', ...flag });
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('startsWith');
    expect(ids(executor.calls)).toEqual(['schema-indexes', 'entity-search', 'search-facets']);
    await app.close();
  });
});

describe('the startsWith group', () => {
  it('holds the entities whose search property starts with the text and is not the text, apart from the exact group, in the order of the types and then by ID', async () => {
    const nodes = [stored('Widget', { widgetId: 'AB' }, 1), stored('Widget', { widgetId: 'ABC-2' }, 2), stored('Gadget', { gadgetId: 'ABD-9' }, 3), stored('Widget', { widgetId: 'ABC-1' }, 4), stored('Widget', { widgetId: 'ZZ' }, 5)];
    const { app } = await started(nodes);
    const result = resultOf(await postSearch(app, typeahead('AB')));
    expect(stableIds(result.exact)).toEqual(['AB']);
    expect(stableIds(result.startsWith?.nodes ?? [])).toEqual(['ABC-1', 'ABC-2', 'ABD-9']);
    expect(result.startsWith?.count).toEqual({ value: 3, quality: 'exact', scope: 'search:startsWith' });
    expect(result.counts.exact).toMatchObject({ value: 1, quality: 'exact' });
    await app.close();
  });

  it.each([
    [24, 24, 'exact'],
    [25, 25, 'exact'],
    [26, 25, 'lowerBound'],
  ])('shows %i matches as %i hits and an %s count', async (matches, shown, quality) => {
    const { app } = await started(widgetsWith('P-', matches));
    const result = resultOf(await postSearch(app, typeahead('P-')));
    expect(result.startsWith?.nodes).toHaveLength(shown);
    expect(result.startsWith?.count).toEqual({ value: shown, quality, scope: 'search:startsWith' });
    expect(result.cap).toBe(25);
    await app.close();
  });

  it.each([
    [10, 10, 'exact'],
    [11, 10, 'lowerBound'],
  ])('shows %i matches as %i hits and an %s count for a source whose max_page is 10, and echoes the cap', async (matches, shown, quality) => {
    const { app } = await started(widgetsWith('P-', matches), { mapping: searchMappingOf({ budgets: { max_page: 10, default_page: 10 } }) });
    const result = resultOf(await postSearch(app, typeahead('P-')));
    expect(result.startsWith?.nodes).toHaveLength(shown);
    expect(result.startsWith?.count).toMatchObject({ value: shown, quality });
    expect(result.cap).toBe(10);
    await app.close();
  });

  it('never repeats an entity the exact group holds, also when it matches the prefix through another property, and counts what is left', async () => {
    const nodes = [stored('Widget', { widgetId: 'AB', ownerName: 'ABEL' }, 1), stored('Widget', { widgetId: 'ABX' }, 2)];
    const { app } = await started(nodes);
    const result = resultOf(await postSearch(app, typeahead('AB')));
    expect(stableIds(result.exact)).toEqual(['AB']);
    expect(stableIds(result.startsWith?.nodes ?? [])).toEqual(['ABX']);
    expect(result.startsWith?.count).toMatchObject({ value: 1, quality: 'exact' });
    await app.close();
  });

  it('counts a lower bound below the cap when the read overflowed and the removal of an exact hit left fewer', async () => {
    const nodes = [stored('Widget', { widgetId: 'AB', ownerName: 'AB-owner' }, 1), ...widgetsWith('AB-', 9, 2), stored('Widget', { widgetId: 'ZZ-10', ownerName: 'AB-other' }, 20)];
    const { app } = await started(nodes, { mapping: searchMappingOf({ budgets: { max_page: 10, default_page: 10 } }) });
    const result = resultOf(await postSearch(app, typeahead('AB')));
    expect(result.cap).toBe(10);
    expect(stableIds(result.exact)).toEqual(['AB']);
    expect(result.startsWith?.nodes).toHaveLength(9);
    expect(result.startsWith?.count).toEqual({ value: 9, quality: 'lowerBound', scope: 'search:startsWith' });
    await app.close();
  });

  it('reports the rows the prefix read left out and why, apart from the exact group', async () => {
    const nodes = [stored('Widget', { ownerName: 'ABEL' }, 1), stored('Widget', { widgetId: 'ABX' }, 2)];
    const { app } = await started(nodes);
    const result = resultOf(await postSearch(app, typeahead('AB')));
    expect(stableIds(result.startsWith?.nodes ?? [])).toEqual(['ABX']);
    expect(result.startsWith?.dropped['no-stable-id']).toBe(1);
    expect(result.startsWith?.warnings.length).toBeGreaterThan(0);
    expect(result.dropped['no-stable-id']).toBe(0);
    expect(result.warnings).toEqual([]);
    await app.close();
  });
});

describe('masking in a type-ahead request', () => {
  const owners = [stored('Widget', { widgetId: 'W-1', ownerName: 'Bo Chen' }, 1), stored('Widget', { widgetId: 'Bo Chen-2' }, 2)];

  it('leaves a personal-data property out of the prefix targets while masked, so it finds only what an eligible property matches, and masks the fields of the hits', async () => {
    const { app, executor } = await started(owners);
    const result = resultOf(await postSearch(app, typeahead('Bo', { mask: true })));
    expect(stableIds(result.startsWith?.nodes ?? [])).toEqual(['Bo Chen-2']);
    expect(executor.calls.filter((call) => call.templateId === 'entity-search-prefix').every((call) => !call.cypher.includes('ownerName'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('"Bo Chen"');
    await app.close();
  });

  it('searches the personal-data property when the request does not ask for masking', async () => {
    const { app } = await started(owners);
    const result = resultOf(await postSearch(app, typeahead('Bo')));
    expect(stableIds(result.startsWith?.nodes ?? []).sort()).toEqual(['Bo Chen-2', 'W-1']);
    await app.close();
  });

  it('answers 200 with an empty startsWith, searchable false and no statement at all when only personal-data properties are left to search', async () => {
    const mapping = searchMappingOf({ entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['ownerName'], pii: [{ property: 'ownerName', class: 'name' }] }] });
    const { app, executor } = await started([], { mapping });
    const response = await postSearch(app, typeahead('Al', { mask: true }));
    expect(response.statusCode).toBe(200);
    const result = resultOf(response);
    expect(result.searchable).toBe(false);
    expect(result.disabledTypes).toEqual([]);
    expect(result.startsWith).toMatchObject({ nodes: [], count: { value: 0, quality: 'exact' } });
    expect(executor.calls).toEqual([]);
    await app.close();
  });
});

describe('a type-ahead request when a search index is not online', () => {
  it('leaves a property out of both groups, names it once with its reason, and searches the rest of its type and the others', async () => {
    const nodes = [stored('Widget', { widgetId: 'AB-1' }, 1), stored('Gadget', { gadgetId: 'AB-2' }, 2)];
    const { app, executor } = await started(nodes, {}, () => schemaAnswer([rangeIndex('Widget', 'widgetId', 'POPULATING'), rangeIndex('Widget', 'ownerName'), rangeIndex('Gadget', 'gadgetId')]));
    const result = resultOf(await postSearch(app, typeahead('AB')));
    expect(result.disabledTypes).toEqual([{ entityType: 'widget', property: 'widgetId', reason: 'index-building', typeSearched: true }]);
    expect(result.searchable).toBe(true);
    expect(stableIds(result.startsWith?.nodes ?? [])).toEqual(['AB-2']);
    expect(executor.calls.filter((call) => call.cypher.includes('`widgetId`'))).toEqual([]);
    expect(executor.calls.filter((call) => call.cypher.includes('`Widget`') && call.cypher.includes('`ownerName`'))).toHaveLength(2);
    await app.close();
  });

  it('runs only the schema read when every type is left out, and answers searchable false with an empty startsWith', async () => {
    const { app, executor, events } = await started([], {}, () => schemaAnswer([]));
    const result = resultOf(await postSearch(app, typeahead('AB')));
    expect(result.searchable).toBe(false);
    expect(result.disabledTypes.map((disabled) => disabled.entityType).sort()).toEqual(['gadget', 'widget', 'widget']);
    expect(result.startsWith).toMatchObject({ nodes: [], count: { value: 0, quality: 'exact' } });
    expect(ids(executor.calls)).toEqual(['schema-indexes']);
    expect(events.filter((event) => event.action === 'entity.search')).toHaveLength(1);
    await app.close();
  });
});

describe('what a type-ahead request costs', () => {
  it('reads the schema once and each group once, and counts each read once through the seam', async () => {
    let reads = 0;
    const defaults = communitySeams();
    const coordinator: Seams['coordinator'] = { acquireRead: (request) => (reads++, defaults.coordinator.acquireRead(request)) };
    const { app, executor, events } = await started(widgetsWith('P-', 3), { coordinator });
    expect((await postSearch(app, typeahead('P-'))).statusCode).toBe(200);
    expect(ids(executor.calls)).toEqual(['schema-indexes', 'entity-search', 'entity-search-prefix']);
    expect(reads).toBe(3);
    expect(events.map((event) => `${event.action} ${event.result}`)).toEqual(['source.schema_indexes success', 'entity.search success', 'entity.search success']);
    await app.close();
  });
});

describe('a type-ahead request that fails', () => {
  const TEXT = 'needle-text-9042';

  it.each([
    ['a schema read that times out', () => ({ status: 'timeout' }) as const, 504, 'QUERY_TIMEOUT', 'failed'],
    ['a source that is busy or down at the schema read', () => ({ status: 'unavailable', reason: 'unreachable' }) as const, 503, 'SOURCE_UNAVAILABLE', 'failed'],
    ['a schema answer that cannot be read', () => ({ status: 'rows', rows: [{ nothing: true }] }) as const, 503, 'SOURCE_UNAVAILABLE', 'refused'],
    ['a schema answer that is truncated', () => schemaAnswer([], true), 503, 'SOURCE_UNAVAILABLE', 'refused'],
  ])('answers %s with its error and runs neither data statement', async (_name, answer, status, code, audited) => {
    const { app, executor, events } = await started([], {}, answer);
    const response = await postSearch(app, typeahead(TEXT));
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(ids(executor.calls)).toEqual(['schema-indexes']);
    expect(events.filter((event) => event.action === 'entity.search')).toEqual([expect.objectContaining({ result: audited })]);
    await app.close();
  });

  it('searches unguarded when the source refuses to list indexes, both groups included', async () => {
    const { app, executor } = await started(widgetsWith('P-', 2), {}, () => ({ status: 'unavailable', reason: 'refused' }));
    const result = resultOf(await postSearch(app, typeahead('P-')));
    expect(result.disabledTypes).toEqual([]);
    expect(result.startsWith?.nodes).toHaveLength(2);
    expect(ids(executor.calls)).toEqual(['schema-indexes', 'entity-search', 'entity-search-prefix']);
    await app.close();
  });

  it('answers a source that is not configured as NOT_FOUND with no statement', async () => {
    const { app, executor } = await started([]);
    const response = await postSearch(app, typeahead('AB', { sourceId: 'absent' }));
    expect(response.statusCode).toBe(404);
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('keeps the typed text out of every log line, error body and audit event', async () => {
    const { app, lines, events } = await started([], {}, () => ({ status: 'timeout' }) as const);
    const response = await postSearch(app, typeahead(TEXT));
    expect(response.body).not.toContain(TEXT);
    expect(lines.join('\n')).not.toContain(TEXT);
    expect(JSON.stringify(events)).not.toContain(TEXT);
    await app.close();
  });
});

describe('a type-ahead request in which one group fails', () => {
  const nodes = [stored('Widget', { widgetId: 'AB' }, 1), stored('Widget', { widgetId: 'AB-1' }, 2), stored('Widget', { widgetId: 'AB-2' }, 3)];
  const model = searchModelOf(nodes);
  const failing = (templateId: string, outcome: (call: ExecuteCall) => ReturnType<typeof model>) =>
    withSchema(() => schemaAnswer(ALL_ONLINE), (call) => (call.templateId === templateId ? outcome(call) : model(call)));
  const timeout = () => Promise.resolve({ status: 'timeout' as const });
  const unreachable = () => Promise.resolve({ status: 'unavailable' as const, reason: 'unreachable' as const });
  const internal = (): never => {
    throw new Error('the read could not be run');
  };

  it.each([
    ['a timeout', timeout, 'QUERY_TIMEOUT', 5000],
    ['an internal error of the read', internal, 'INTERNAL_ERROR', undefined],
  ])('keeps the exact group and says the startsWith read failed, for %s, with no hit and an unknown count for the failed group', async (_name, outcome, code, timeoutMs) => {
    const { app, events } = await startSearchApp({ ownSchema: true, respond: failing('entity-search-prefix', outcome) });
    const response = await postSearch(app, typeahead('AB'));
    expect(response.statusCode).toBe(200);
    const result = resultOf(response);
    expect(stableIds(result.exact)).toEqual(['AB']);
    expect(result.counts.exact).toMatchObject({ value: 1, quality: 'exact' });
    expect(result.startsWith).toMatchObject({ nodes: [], count: { quality: 'unknown' } });
    expect(result.startsWith?.count).not.toHaveProperty('value');
    expect(result.failures).toEqual([{ group: 'startsWith', code, ...(timeoutMs === undefined ? {} : { timeoutMs }) }]);
    expect(events.filter((event) => event.action === 'entity.search').map((event) => event.result)).toEqual(['success', 'failed']);
    await app.close();
  });

  it('answers a busy source for the second read as a failed startsWith group, and keeps the exact group', async () => {
    let reads = 0;
    const defaults = communitySeams();
    const coordinator: Seams['coordinator'] = { acquireRead: (request) => (++reads === 3 ? Promise.resolve({ status: 'busy' }) : defaults.coordinator.acquireRead(request)) };
    const { app, executor } = await started(nodes, { coordinator });
    const result = resultOf(await postSearch(app, typeahead('AB')));
    expect(stableIds(result.exact)).toEqual(['AB']);
    expect(result.failures).toEqual([{ group: 'startsWith', code: 'SOURCE_BUSY' }]);
    expect(executor.calls.map((call) => call.templateId)).not.toContain('entity-search-prefix');
    await app.close();
  });

  it('keeps the startsWith group and says the exact read failed, with no exact hit and an unknown exact count', async () => {
    const { app, events } = await startSearchApp({ ownSchema: true, respond: failing('entity-search', timeout) });
    const result = resultOf(await postSearch(app, typeahead('AB')));
    expect(result.exact).toEqual([]);
    expect(result.counts.exact.quality).toBe('unknown');
    expect(result.counts.exact).not.toHaveProperty('value');
    expect(stableIds(result.startsWith?.nodes ?? [])).toEqual(['AB-1', 'AB-2']);
    expect(result.failures).toEqual([{ group: 'exact', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }]);
    expect(events.filter((event) => event.action === 'entity.search').map((event) => event.result)).toEqual(['failed', 'success']);
    await app.close();
  });

  it('fails the whole request with the exact error when both groups fail, and makes both reads', async () => {
    const respond = withSchema(() => schemaAnswer(ALL_ONLINE), (call) => (call.templateId === 'entity-search' ? timeout() : internal()));
    const { app, executor } = await startSearchApp({ ownSchema: true, respond });
    const response = await postSearch(app, typeahead('AB'));
    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe('QUERY_TIMEOUT');
    expect(response.json()).not.toHaveProperty('exact');
    expect(ids(executor.calls)).toEqual(['schema-indexes', 'entity-search', 'entity-search-prefix']);
    await app.close();
  });

  it('fails the whole request for an error that means the same for both groups, whichever read raised it', async () => {
    const { app } = await startSearchApp({ ownSchema: true, respond: failing('entity-search-prefix', unreachable) });
    const response = await postSearch(app, typeahead('AB'));
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('SOURCE_UNAVAILABLE');
    expect(response.json()).not.toHaveProperty('exact');
    await app.close();
  });

  it('fails the search as a whole when the only group read fails, as before', async () => {
    const { app } = await startSearchApp({ ownSchema: true, respond: failing('entity-search', timeout) });
    const response = await postSearch(app, { sourceId: 'demo', text: 'AB' });
    expect(response.statusCode).toBe(504);
    await app.close();
  });
});
