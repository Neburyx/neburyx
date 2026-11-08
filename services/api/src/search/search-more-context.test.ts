import { searchMoreResultSchema, searchResultSchema, type GraphNode, type SearchMoreResult, type SearchResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { contextCalls, postMore, postSearch, RELATED_ENTITIES, searchMappingOf, startSearchApp, type SearchAppOptions } from '../testing/search-app.js';
import { onlineIndexesOf, schemaAnswer, searchModelOf, withSchema, type StoredNode } from '../testing/search-fixtures.js';

const TEXT = 'X-1';
const mapping = searchMappingOf({ entities: RELATED_ENTITIES, relationships: [{ type: 'FOR', from: 'gadget', to: 'widget' }] });
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');

const gadgets: StoredNode[] = Array.from({ length: 40 }, (_, index) => ({ elementId: `4:g:${String(index).padStart(3, '0')}`, label: 'Gadget', properties: { gadgetId: `GT-${index}`, widgetRef: TEXT } }));
const stored: StoredNode[] = [{ elementId: '4:s:3', label: 'Widget', properties: { widgetId: TEXT } }, ...gadgets];

/** Answers the context read as the server would: every hit it is given is related to the first exact match by FOR. */
const everyHitFor = (call: ExecuteCall): Promise<ExecuteOutcome> => {
  const hits = call.parameters['hits'] as unknown[];
  return Promise.resolve({ status: 'rows', rows: hits.map((_hit, hi) => ({ hi, bi: 0, ei: 0, rtype: 'FOR', dir: 'out' })) });
};

const started = (options: SearchAppOptions = {}) => startSearchApp({ mapping, respond: searchModelOf(stored), context: everyHitFor, ...options });

async function firstPage(app: Awaited<ReturnType<typeof started>>['app']): Promise<SearchResult> {
  const response = await postSearch(app, { sourceId: 'demo', text: TEXT });
  expect(response.statusCode).toBe(200);
  return searchResultSchema.parse(response.json());
}

const asked = (app: Awaited<ReturnType<typeof started>>['app'], first: SearchResult, extra: Record<string, unknown> = {}, group = 'related') =>
  postMore(app, { sourceId: 'demo', text: TEXT, group, cursor: group === 'related' ? first.related.nextCursor : first.exactNextCursor, ...extra });

const refOf = (node: GraphNode): GraphNode['ref'] => node.ref;

describe('the next page of the related group', () => {
  it('holds the relationship context of its records against the exact matches the request carries, from one read for the page', async () => {
    const { app, executor } = await started();
    const first = await firstPage(app);
    expect(first.related.hits).toHaveLength(25);
    expect(contextCalls(executor)).toHaveLength(1);
    const response = await asked(app, first, { exactRefs: first.exact.map(refOf) });
    expect(response.statusCode).toBe(200);
    const page = searchMoreResultSchema.parse(response.json());
    if (page.group !== 'related') throw new Error('not a related page');
    expect(page.hits).toHaveLength(15);
    expect(page.hits.every((hit) => hit.context?.relationshipType === 'FOR' && hit.context.direction === 'out')).toBe(true);
    expect(page.hits[0]?.context?.with).toEqual(first.exact[0]?.ref);
    expect(contextCalls(executor)).toHaveLength(2);
    expect((contextCalls(executor)[1]?.parameters['hits'] as unknown[]).length).toBe(15);
    expect(page.contextFailure).toBeUndefined();
    await app.close();
  });

  it('makes no context read, and holds no context, when the request carries no exact match', async () => {
    const { app, executor } = await started();
    const first = await firstPage(app);
    const page = searchMoreResultSchema.parse((await asked(app, first)).json());
    if (page.group !== 'related') throw new Error('not a related page');
    expect(page.hits.every((hit) => hit.context === undefined)).toBe(true);
    const empty = searchMoreResultSchema.parse((await asked(app, first, { exactRefs: [] })).json());
    if (empty.group !== 'related') throw new Error('not a related page');
    expect(empty.hits.every((hit) => hit.context === undefined)).toBe(true);
    expect(contextCalls(executor)).toHaveLength(1);
    await app.close();
  });

  it.each([
    ['more references than the cap', (first: SearchResult) => Array.from({ length: 26 }, (_, index) => ({ ...(first.exact[0]?.ref as GraphNode['ref']), stableId: `X-${index}` }))],
    ['a reference of another source', (first: SearchResult) => [{ ...(first.exact[0]?.ref as GraphNode['ref']), sourceId: 'other' }]],
    ['a reference of an entity type the mapping does not hold', (first: SearchResult) => [{ ...(first.exact[0]?.ref as GraphNode['ref']), entityType: 'nothing' }]],
    ['a reference with a field the contract does not name', (first: SearchResult) => [{ ...(first.exact[0]?.ref as GraphNode['ref']), extra: 1 }]],
  ])('refuses %s as INVALID_REQUEST, and runs no statement', async (_name, refs) => {
    const { app, executor } = await started();
    const first = await firstPage(app);
    const before = executor.calls.length;
    const response = await asked(app, first, { exactRefs: refs(first) });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(executor.calls).toHaveLength(before);
    await app.close();
  });

  it('refuses references for the exact and the evidence group, and runs no statement', async () => {
    const { app, executor } = await started();
    const first = await firstPage(app);
    const before = executor.calls.length;
    for (const group of ['exact', 'evidence']) {
      const response = await postMore(app, { sourceId: 'demo', text: TEXT, group, cursor: first.exactNextCursor ?? first.related.nextCursor, exactRefs: first.exact.map(refOf) });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
    }
    expect(executor.calls).toHaveLength(before);
    await app.close();
  });

  it('keeps the records, the count and the cursor, names the failure of the context read in contextFailure, and leaves failure unset', async () => {
    const { app } = await started({ context: () => Promise.resolve({ status: 'timeout' }) });
    const first = await firstPage(app);
    const response = await asked(app, first, { exactRefs: first.exact.map(refOf) });
    expect(response.statusCode).toBe(200);
    const page: SearchMoreResult = searchMoreResultSchema.parse(response.json());
    if (page.group !== 'related') throw new Error('not a related page');
    expect(page.failure).toBeUndefined();
    expect(page.contextFailure).toEqual({ group: 'context', code: 'QUERY_TIMEOUT', timeoutMs: 5000 });
    expect(page.hits).toHaveLength(15);
    expect(page.hits.every((hit) => hit.context === undefined)).toBe(true);
    expect(page.count).toMatchObject({ value: 40, quality: 'exact' });
    await app.close();
  });

  it('fails the request, as for every read, when the failure means the same for all of them', async () => {
    let reads = 0;
    // the first page's context read answers; the page's own is the one that finds the source down
    const { app } = await started({ context: (call) => (++reads === 1 ? everyHitFor(call) : Promise.resolve({ status: 'unavailable', reason: 'unreachable' })) });
    const first = await firstPage(app);
    const response = await asked(app, first, { exactRefs: first.exact.map(refOf) });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it('names the types whose pairs were left out for want of a stable-ID index, and reads the pairs of the others', async () => {
    const without = onlineIndexesOf(source).filter((row) => row.property !== 'widgetId');
    const { app } = await startSearchApp({ mapping, ownSchema: true, respond: withSchema(() => schemaAnswer(without), searchModelOf(stored)), context: everyHitFor });
    const first = await firstPage(app);
    expect(first.exact).toHaveLength(0);
    const response = await postMore(app, { sourceId: 'demo', text: TEXT, group: 'related', cursor: first.related.nextCursor, exactRefs: [{ sourceId: 'demo', entityType: 'widget', stableId: TEXT }] });
    const page = searchMoreResultSchema.parse(response.json());
    if (page.group !== 'related') throw new Error('not a related page');
    expect(page.context).toEqual({ disabledTypes: [{ entityType: 'widget', property: 'widgetId', reason: 'index-unavailable', typeSearched: false }] });
    expect(page.hits.every((hit) => hit.context === undefined)).toBe(true);
    await app.close();
  });
});
