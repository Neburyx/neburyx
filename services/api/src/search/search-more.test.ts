import { searchMoreResultSchema, searchResultSchema, type SearchMoreResult, type SearchResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { SYSTEM_ID } from '../gate/system-principal.js';
import { communitySeams } from '../seams/community-seams.js';
import { evidenceCalls, postMore, postSearch, prefixCalls, relatedCalls, searchCalls, searchMappingOf, startSearchApp, type SearchApp } from '../testing/search-app.js';
import { onlineIndexesOf, schemaAnswer, searchModelOf, withSchema, type StoredNode, type StoredRelationship, storedHits } from '../testing/search-fixtures.js';

const TEXT = 'needle';
const MATCHES = 61;
const ENTITIES = [
  { type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['widgetId', 'nickname', 'ownerName'], reference: ['batchRef'], pii: [{ property: 'ownerName', class: 'name' }] },
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['gadgetId', 'region'] },
];
const RELATIONSHIPS = [{ type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId'] }];
const mapping = searchMappingOf({ entities: ENTITIES, relationships: RELATIONSHIPS });
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');

const GADGET: StoredNode = { elementId: '4:g:0', label: 'Gadget', properties: { gadgetId: 'GD-0' } };
const widgets: StoredNode[] = Array.from({ length: MATCHES }, (_, index) => ({
  elementId: `4:w:${index}`,
  label: 'Widget',
  properties: { widgetId: `W-${index}`, nickname: TEXT, batchRef: TEXT, ownerName: index === 0 ? TEXT : `Owner ${index}` },
}));
const links: StoredRelationship[] = Array.from({ length: MATCHES }, (_, index) => ({ elementId: `5:r:${index}`, type: 'MADE_FROM', from: widgets[index] ?? GADGET, to: GADGET, properties: { linkId: `L-${index}`, recordId: TEXT } }));

const model = searchModelOf([...widgets, GADGET], () => undefined, links);
const started = (respond: (call: ExecuteCall) => Promise<ExecuteOutcome> = model, ownSchema = false) => startSearchApp({ mapping, respond, ownSchema });

async function firstPage(app: SearchApp['app'], extra: Record<string, unknown> = {}): Promise<SearchResult> {
  const response = await postSearch(app, { sourceId: 'demo', text: TEXT, ...extra });
  expect(response.statusCode).toBe(200);
  return searchResultSchema.parse(response.json());
}

async function more(app: SearchApp['app'], body: Record<string, unknown>): Promise<SearchMoreResult> {
  const response = await postMore(app, { sourceId: 'demo', text: TEXT, ...body });
  expect(response.statusCode).toBe(200);
  return searchMoreResultSchema.parse(response.json());
}

const idsOf = (page: SearchMoreResult): readonly string[] => {
  switch (page.group) {
    case 'exact':
      return page.nodes.map((node) => node.ref.stableId);
    case 'related':
      return page.hits.map((hit) => hit.node.ref.stableId);
    case 'evidence':
      return storedHits(page.hits).map((hit) => hit.supports.stableId);
    default:
      return [];
  }
};

describe('POST /v1/search/entities/more refused before any page is read', () => {
  it('answers a body that is not valid, a group it does not know and a cursor that is empty with INVALID_REQUEST', async () => {
    const { app } = await started();
    for (const body of [{ group: 'exact' }, { group: 'facets', cursor: 'v1.a.b' }, { group: 'exact', cursor: '' }, { group: 'exact', cursor: 'v1.a.b', matchModes: ['exact'] }, { group: 'exact', cursor: 'v1.a.b', text: '' }]) {
      const response = await postMore(app, { sourceId: 'demo', text: TEXT, ...body });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
    }
    await app.close();
  });

  it('refuses the startsWith group, which is capped and has no next page, and an entity type the mapping does not name, as INVALID_REQUEST and without reading', async () => {
    const { app, executor } = await started();
    for (const body of [{ group: 'startsWith', cursor: 'v1.a.b' }, { group: 'startsWith', cursor: 'v1.a.b', entityTypes: ['widget'] }, { group: 'exact', cursor: 'v1.a.b', entityTypes: ['nothing'] }]) {
      const response = await postMore(app, { sourceId: 'demo', text: TEXT, ...body });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
    }
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('answers a source that is not configured with NOT_FOUND', async () => {
    const { app } = await started();
    const response = await postMore(app, { sourceId: 'absent', text: TEXT, group: 'exact', cursor: 'v1.a.b' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe('a search whose groups have more matches than the page', () => {
  it('gives each group with more a cursor and a lower-bound count of the hits held, and the facets count past the page', async () => {
    const { app } = await started();
    const answer = await firstPage(app);
    expect(answer.exact).toHaveLength(25);
    expect(answer.counts.exact).toEqual({ value: 25, quality: 'lowerBound', scope: 'search:exact' });
    expect(answer.exactNextCursor).toEqual(expect.any(String));
    expect(answer.related.count).toEqual({ value: 25, quality: 'lowerBound', scope: 'search:related' });
    expect(answer.related.nextCursor).toEqual(expect.any(String));
    expect(answer.evidence.count).toEqual({ value: 25, quality: 'lowerBound', scope: 'search:evidence' });
    expect(answer.evidence.nextCursor).toEqual(expect.any(String));
    expect(answer.facets).toMatchObject({ searchable: true, total: { value: MATCHES, quality: 'exact' }, matchMode: [{ mode: 'exact', count: { value: MATCHES, quality: 'exact' } }, { mode: 'related', count: { value: MATCHES, quality: 'exact' } }, { mode: 'evidence', count: { value: MATCHES, quality: 'exact' } }] });
    await app.close();
  });

  it('gives a group with no more matches no cursor and an exact count', async () => {
    const few = searchModelOf(widgets.slice(0, 3), () => undefined, links.slice(0, 2));
    const { app } = await started(few);
    const answer = await firstPage(app);
    expect(answer.counts.exact).toEqual({ value: 3, quality: 'exact', scope: 'search:exact' });
    expect(answer.exactNextCursor).toBeUndefined();
    expect(answer.related.nextCursor).toBeUndefined();
    expect(answer.evidence).toMatchObject({ count: { value: 2, quality: 'exact' } });
    expect(answer.evidence.nextCursor).toBeUndefined();
    await app.close();
  });

  it('keeps every group, its hits and its cursor when the facet read fails, and names the failure as before', async () => {
    const { app } = await started((call) => (call.templateId === 'search-facets' ? Promise.resolve({ status: 'timeout' }) : model(call)));
    const answer = await firstPage(app);
    expect(answer.failures).toEqual([{ group: 'facets', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }]);
    expect(answer.facets).toEqual({ searchable: true, total: { quality: 'unknown', scope: 'search:facet:total' }, entityType: [], matchMode: [] });
    expect([answer.exactNextCursor, answer.related.nextCursor, answer.evidence.nextCursor].every((cursor) => typeof cursor === 'string')).toBe(true);
    expect(idsOf(await more(app, { group: 'exact', cursor: answer.exactNextCursor }))).toHaveLength(25);
    await app.close();
  });

  it('keeps the other groups, their hits and their cursors when the sorted read of one group times out', async () => {
    const { app } = await started((call) => (call.templateId === 'entity-search' ? Promise.resolve({ status: 'timeout' }) : model(call)));
    const answer = await firstPage(app);
    expect(answer.failures).toEqual([{ group: 'exact', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }]);
    expect(answer.exactNextCursor).toBeUndefined();
    expect(answer.related.hits).toHaveLength(25);
    expect(answer.related.nextCursor).toEqual(expect.any(String));
    await app.close();
  });
});

describe('the next pages of one group', () => {
  it.each([
    ['exact', (answer: SearchResult) => answer.exactNextCursor, searchCalls],
    ['related', (answer: SearchResult) => answer.related.nextCursor, relatedCalls],
    ['evidence', (answer: SearchResult) => answer.evidence.nextCursor, evidenceCalls],
  ] as const)('reads only the %s group, through the gate, reaches every match once over three pages, and counts the hits of every page so far', async (group, cursorOf, callsOf) => {
    const { app, executor } = await started();
    const answer = await firstPage(app);
    const before = executor.calls.length;
    const second = await more(app, { group, cursor: cursorOf(answer) });
    expect(second.group).toBe(group);
    expect(idsOf(second)).toHaveLength(25);
    expect(second.count).toEqual({ value: 50, quality: 'lowerBound', scope: `search:${group}` });
    const third = await more(app, { group, cursor: second.nextCursor });
    expect(idsOf(third)).toHaveLength(11);
    expect(third.count).toEqual({ value: MATCHES, quality: 'exact', scope: `search:${group}` });
    expect(third.nextCursor).toBeUndefined();
    const firstIds = group === 'exact' ? answer.exact.map((node) => node.ref.stableId) : group === 'related' ? answer.related.hits.map((hit) => hit.node.ref.stableId) : storedHits(answer.evidence.hits).map((hit) => hit.supports.stableId);
    const all = [...firstIds, ...idsOf(second), ...idsOf(third)];
    expect(new Set(all).size).toBe(MATCHES);
    // each page is one schema read, read fresh, and one read of its own group, and nothing else
    expect(executor.calls.slice(before).map((call) => call.templateId)).toEqual(['schema-indexes', callsOf(executor)[0]?.templateId, 'schema-indexes', callsOf(executor)[0]?.templateId]);
    expect(callsOf(executor)).toHaveLength(3);
    await app.close();
  });

  it('names the reference properties that matched on each related hit of a page', async () => {
    const { app } = await started();
    const answer = await firstPage(app);
    const page = await more(app, { group: 'related', cursor: answer.related.nextCursor });
    expect(page.group === 'related' && page.hits.every((hit) => hit.matchedProperties.join() === 'batchRef')).toBe(true);
    await app.close();
  });

  it('gives the startsWith group of a type-ahead search a lower-bound count and no cursor when its capped read is cut', async () => {
    const { app, executor } = await started();
    const response = await postSearch(app, { sourceId: 'demo', text: 'nee', typeahead: true });
    const answer = searchResultSchema.parse(response.json());
    expect(answer.startsWith?.count).toEqual({ value: 25, quality: 'lowerBound', scope: 'search:startsWith' });
    expect(answer.startsWith).not.toHaveProperty('nextCursor');
    expect(prefixCalls(executor)).toHaveLength(1);
    expect(prefixCalls(executor)[0]?.cypher).not.toMatch(/ORDER BY|\$cursor/);
    await app.close();
  });

  it('pages the exact group of a type-ahead search with the cursor that answer gave, as the canvas Search panel does', async () => {
    const { app } = await started();
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: TEXT, typeahead: true })).json());
    expect(answer.exactNextCursor).toBeDefined();
    const page = await more(app, { group: 'exact', cursor: answer.exactNextCursor });
    expect(page.group).toBe('exact');
    expect(idsOf(page)).toHaveLength(25);
    expect(idsOf(page).some((id) => answer.exact.some((node) => node.ref.stableId === id))).toBe(false);
    await app.close();
  });

  it('applies the same masking and the same searched properties as the first page', async () => {
    const { app, executor } = await started();
    const answer = await firstPage(app, { mask: true });
    expect(searchCalls(executor)[0]?.cypher).not.toContain('ownerName');
    const page = await more(app, { group: 'exact', cursor: answer.exactNextCursor, mask: true });
    expect(searchCalls(executor)[1]?.cypher).toBe(searchCalls(executor)[0]?.cypher);
    expect(page.group === 'exact' && page.nodes.every((node) => node.properties.find((property) => property.key === 'ownerName')?.masked === true)).toBe(true);
    expect(JSON.stringify(page)).not.toContain('Owner 3');
    await app.close();
  });

  it('narrows the exact group by the same entity types as the first page', async () => {
    const { app, executor } = await started();
    const answer = await firstPage(app, { entityTypes: ['widget'] });
    await more(app, { group: 'exact', cursor: answer.exactNextCursor, entityTypes: ['widget'] });
    expect(searchCalls(executor)[1]?.cypher).toBe(searchCalls(executor)[0]?.cypher);
    expect(searchCalls(executor)[1]?.cypher).not.toContain('Gadget');
    await app.close();
  });
});

describe('a cursor that does not belong to the page asked for', () => {
  it('refuses a cursor sent for another group, with another text, another selection, another mask or a changed byte, as CURSOR_INVALIDATED', async () => {
    const { app } = await started();
    const answer = await firstPage(app);
    const cursor = answer.exactNextCursor ?? '';
    const changed = cursor.slice(0, 12) + (cursor[12] === 'A' ? 'B' : 'A') + cursor.slice(13);
    const refused = [
      { group: 'related', cursor },
      { group: 'evidence', cursor },
      { group: 'exact', cursor: answer.related.nextCursor },
      { group: 'exact', cursor, text: 'needle-2' },
      { group: 'exact', cursor, entityTypes: ['widget'] },
      { group: 'exact', cursor, mask: true },
      { group: 'exact', cursor: changed },
    ];
    for (const body of refused) {
      const response = await postMore(app, { sourceId: 'demo', text: TEXT, ...body });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatchObject({ code: 'CURSOR_INVALIDATED', retryable: false });
      expect(JSON.stringify(response.json())).not.toContain(TEXT);
    }
    await app.close();
  });

  it('refuses a cursor whose count of the hits held was edited, as CURSOR_INVALIDATED and without reading the group', async () => {
    const { app, executor } = await started();
    const answer = await firstPage(app);
    const [version, body, mac] = (answer.exactNextCursor ?? '').split('.');
    const payload = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8')) as { readonly d: Record<string, unknown> };
    expect(payload.d['held']).toBe(25);
    const edited = `${version}.${Buffer.from(JSON.stringify({ ...payload, d: { ...payload.d, held: 1000 } }), 'utf8').toString('base64url')}.${mac}`;
    const calls = searchCalls(executor).length;
    const response = await postMore(app, { sourceId: 'demo', text: TEXT, group: 'exact', cursor: edited });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CURSOR_INVALIDATED');
    expect(searchCalls(executor)).toHaveLength(calls);
    await app.close();
  });

  it('refuses a cursor once an index of the plan is no longer online, as the plan of the page is not the first page plan', async () => {
    let indexes = onlineIndexesOf(source);
    const { app } = await startSearchApp({ mapping, respond: withSchema(() => schemaAnswer(indexes), model), ownSchema: true });
    const answer = await firstPage(app);
    indexes = indexes.filter((index) => index.property !== 'nickname');
    const response = await postMore(app, { sourceId: 'demo', text: TEXT, group: 'exact', cursor: answer.exactNextCursor });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CURSOR_INVALIDATED');
    await app.close();
  });
});

describe('a page whose read fails', () => {
  it('answers a timeout of the sorted read as the failure of the group, with its budget, no hit and an unknown count, and the same cursor reads the page on a retry', async () => {
    let failing = true;
    const { app, events } = await started((call) => (failing && call.templateId === 'entity-search' && call.parameters['cursor'] !== null ? Promise.resolve({ status: 'timeout' }) : model(call)));
    const answer = await firstPage(app);
    const failed = await more(app, { group: 'exact', cursor: answer.exactNextCursor });
    expect(failed).toEqual({ sourceId: 'demo', group: 'exact', nodes: [], count: { quality: 'unknown', scope: 'search:exact' }, dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [], failure: { group: 'exact', code: 'QUERY_TIMEOUT', timeoutMs: 5000 } });
    expect(events.filter((event) => event.action === 'entity.search').map((event) => event.result)).toContain('failed');
    failing = false;
    const retried = await more(app, { group: 'exact', cursor: answer.exactNextCursor });
    expect(idsOf(retried)).toHaveLength(25);
    await app.close();
  });

  it('answers a busy source for the page as the failure of its group', async () => {
    let busy = false;
    const defaults = communitySeams();
    // the schema read is the system's and is admitted; only the group's read finds the source busy
    const coordinator = { acquireRead: (request: Parameters<typeof defaults.coordinator.acquireRead>[0]) => (busy && request.principal.id !== SYSTEM_ID ? Promise.resolve({ status: 'busy' as const }) : defaults.coordinator.acquireRead(request)) };
    const { app } = await startSearchApp({ mapping, respond: model, coordinator });
    const answer = await firstPage(app);
    busy = true;
    const page = await more(app, { group: 'related', cursor: answer.related.nextCursor });
    expect(page).toMatchObject({ group: 'related', hits: [], count: { quality: 'unknown' }, failure: { group: 'related', code: 'SOURCE_BUSY' } });
    expect(page.nextCursor).toBeUndefined();
    await app.close();
  });

  it('answers a read the adapter could not run as an internal failure of the group, with nothing of the error in the answer', async () => {
    const { app } = await started((call) => (call.templateId === 'relationship-evidence' && call.parameters['cursor'] !== null ? Promise.reject(new Error(`server said ${TEXT}`)) : model(call)));
    const answer = await firstPage(app);
    const response = await postMore(app, { sourceId: 'demo', text: TEXT, group: 'evidence', cursor: answer.evidence.nextCursor });
    expect(searchMoreResultSchema.parse(response.json())).toMatchObject({ group: 'evidence', hits: [], failure: { group: 'evidence', code: 'INTERNAL_ERROR' } });
    expect(response.body).not.toContain('server said');
    await app.close();
  });

  it('fails the request with its own code for a failure that means the same for every group, and for a failed schema read', async () => {
    let down = false;
    let schemaTimeout = false;
    const respond = (call: ExecuteCall): Promise<ExecuteOutcome> => {
      if (call.templateId === 'schema-indexes') return Promise.resolve(schemaTimeout ? { status: 'timeout' } : schemaAnswer(onlineIndexesOf(source)));
      return down ? Promise.resolve({ status: 'unavailable', reason: 'unreachable' }) : model(call);
    };
    const { app } = await started(respond, true);
    const answer = await firstPage(app);
    down = true;
    const unavailable = await postMore(app, { sourceId: 'demo', text: TEXT, group: 'exact', cursor: answer.exactNextCursor });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.code).toBe('SOURCE_UNAVAILABLE');
    down = false;
    schemaTimeout = true;
    const timedOut = await postMore(app, { sourceId: 'demo', text: TEXT, group: 'exact', cursor: answer.exactNextCursor });
    expect(timedOut.statusCode).toBe(504);
    expect(timedOut.json().error.code).toBe('QUERY_TIMEOUT');
    await app.close();
  });
});
