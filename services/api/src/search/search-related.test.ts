import { searchResultSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { onlineIndexesOf, schemaAnswer, searchModelOf, withSchema, type StoredNode } from '../testing/search-fixtures.js';
import { postSearch, relatedCalls, RELATED_ENTITIES, searchCalls, searchMappingOf, startSearchApp } from '../testing/search-app.js';

const mapping = searchMappingOf({ entities: RELATED_ENTITIES });
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');

const stored: StoredNode[] = [
  { elementId: '4:s:1', label: 'Widget', properties: { widgetId: 'W-1', ownerName: 'Ivo Lowe', batchRef: 'X-1', ownerRef: 'O-9' } },
  { elementId: '4:s:2', label: 'Gadget', properties: { gadgetId: 'GT-1', widgetRef: 'X-1' } },
  { elementId: '4:s:3', label: 'Widget', properties: { widgetId: 'X-1', batchRef: 'BT-0' } },
  { elementId: '4:s:4', label: 'Part', properties: { partId: 'P-1' } },
];

const started = (options: Parameters<typeof startSearchApp>[0] = {}) => startSearchApp({ mapping, respond: searchModelOf(stored), ...options });

describe('POST /v1/search/entities with related records', () => {
  it('returns the records that reference the text in their own group, beside the exact match, and never counts them as exact', async () => {
    const { app, executor } = await started();
    const response = await postSearch(app, { sourceId: 'demo', text: 'X-1' });
    expect(response.statusCode).toBe(200);
    const answer = searchResultSchema.parse(response.json());
    expect(answer.exact.map((node) => node.ref.stableId)).toEqual(['X-1']);
    expect(answer.counts.exact).toMatchObject({ value: 1, quality: 'exact', scope: 'search:exact' });
    expect(answer.related.hits.map((hit) => `${hit.node.ref.entityType}/${hit.node.ref.stableId}`)).toEqual(['widget/W-1', 'gadget/GT-1']);
    expect(answer.related.count).toMatchObject({ value: 2, quality: 'exact', scope: 'search:related' });
    expect(answer.related.searchable).toBe(true);
    expect(answer.related.disabledTypes).toEqual([]);
    expect(executor.calls.map((call) => call.templateId).sort()).toEqual(['entity-related', 'entity-search', 'schema-indexes']);
    await app.close();
  });

  it('makes at most one data read for each group and one schema read, and the related statement names only types with a reference property', async () => {
    const { app, executor } = await started();
    await postSearch(app, { sourceId: 'demo', text: 'X-1' });
    expect(searchCalls(executor)).toHaveLength(1);
    expect(relatedCalls(executor)).toHaveLength(1);
    expect(executor.calls.filter((call) => call.templateId === 'schema-indexes')).toHaveLength(1);
    const [call] = relatedCalls(executor);
    expect(call?.cypher).toContain('MATCH (n:`Widget`) WHERE n.`batchRef`');
    expect(call?.cypher).toContain('MATCH (n:`Gadget`) WHERE n.`widgetRef`');
    expect(call?.cypher).not.toContain('Part');
    expect(call?.cypher).not.toContain('widgetId');
    expect(call?.rowLimit).toBe(26);
    await app.close();
  });

  it('records one event for the exact run, one for the related run and one for the schema read, and none carries the typed text', async () => {
    const text = 'X-1';
    const { app, events, lines } = await started();
    await postSearch(app, { sourceId: 'demo', text });
    expect(events.map((event) => `${event.action} ${event.result}`).sort()).toEqual(['entity.search success', 'entity.search_related success', 'source.schema_indexes success']);
    expect(JSON.stringify(events)).not.toContain(text);
    expect(lines.join('\n')).not.toContain(text);
    await app.close();
  });

  it('makes no related run, and answers a group that is not searchable, for a source with no reference property', async () => {
    const plain = searchMappingOf();
    const { app, executor } = await startSearchApp({ mapping: plain, respond: searchModelOf(stored) });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'W-1' })).json());
    expect(answer.related).toMatchObject({ hits: [], searchable: false, disabledTypes: [], count: { value: 0, quality: 'exact', scope: 'search:related' } });
    expect(relatedCalls(executor)).toEqual([]);
    expect(answer.exact.map((node) => node.ref.stableId)).toEqual(['W-1']);
    await app.close();
  });

  it('leaves a type whose reference index is not online out of the related read, so the read never scans it', async () => {
    const without = onlineIndexesOf(source).filter((row) => row.property !== 'batchRef');
    const { app, executor } = await started({ ownSchema: true, respond: withSchema(() => schemaAnswer(without), searchModelOf(stored)) });
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'X-1' })).json());
    const [call] = relatedCalls(executor);
    expect(call?.cypher).not.toContain('Widget');
    expect(call?.cypher).toContain('Gadget');
    expect(answer.related.hits.map((hit) => hit.node.ref.stableId)).toEqual(['GT-1']);
    expect(answer.related.disabledTypes).toEqual([{ entityType: 'widget', reason: 'index-unavailable' }]);
    await app.close();
  });
});

describe('the reads of a search counted through the seam', () => {
  it('costs one read for the schema, one for the exact group and one for the related group, each acquired once', async () => {
    let acquired = 0;
    const counting = { acquireRead: () => Promise.resolve((acquired += 1, { status: 'granted', lease: { release: () => Promise.resolve() } } as const)) };
    const { app } = await started({ coordinator: counting });
    await postSearch(app, { sourceId: 'demo', text: 'X-1' });
    expect(acquired).toBe(3);
    await app.close();
  });

  it('costs two reads when only the exact group has a property to read, and the schema read is shared', async () => {
    let acquired = 0;
    const counting = { acquireRead: () => Promise.resolve((acquired += 1, { status: 'granted', lease: { release: () => Promise.resolve() } } as const)) };
    const plain = searchMappingOf();
    const { app } = await startSearchApp({ mapping: plain, respond: searchModelOf(stored), coordinator: counting });
    await postSearch(app, { sourceId: 'demo', text: 'W-1' });
    expect(acquired).toBe(2);
    await app.close();
  });
});

describe('POST /v1/search/entities refuses and hides', () => {
  it.each([
    ['a group name', { sourceId: 'demo', text: 'ab', group: 'related' }],
    ['a reference property', { sourceId: 'demo', text: 'ab', reference: 'batchRef' }],
    ['a list of related targets', { sourceId: 'demo', text: 'ab', related: [{ entityType: 'widget', property: 'batchRef' }] }],
  ])('answers INVALID_REQUEST for %s, with no read', async (_name, body) => {
    const { app, executor } = await started();
    const response = await postSearch(app, body);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('answers the same NOT_FOUND for a source the person may not read as for one that is not configured, and reads neither group', async () => {
    const { app, executor, events } = await started({ policy: { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'denied' }) } });
    const unreadable = await postSearch(app, { sourceId: 'demo', text: 'X-1' });
    const unknown = await postSearch(app, { sourceId: 'nope', text: 'X-1' });
    expect(unreadable.statusCode).toBe(404);
    expect(unreadable.json().error.code).toBe('NOT_FOUND');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('NOT_FOUND');
    expect(executor.calls).toEqual([]);
    expect(events.every((event) => event.result === 'denied')).toBe(true);
    await app.close();
  });
});
