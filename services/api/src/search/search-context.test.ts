import { searchResultSchema, type GraphNode, type SearchResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { AppError, RequestCancelled } from '../errors.js';
import { createTemplateCatalog, type TemplateDefinition } from '../gate/catalog.js';
import { schemaIndexesTemplate } from '../gate/templates/schema-indexes.js';
import { searchExactTemplate } from '../gate/templates/search-exact.js';
import { searchFacetsTemplate } from '../gate/templates/search-facets.js';
import { searchRelatedTemplate } from '../gate/templates/search-related.js';
import { RELATED_CONTEXT_ID, relatedContextTemplate } from '../gate/templates/related-context.js';
import type { Gate, GatePage } from '../gate/types.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { createSearchService } from './search-service.js';
import { contextCalls, postSearch, RELATED_ENTITIES, searchMappingOf, startSearchApp, type SearchAppOptions } from '../testing/search-app.js';
import { onlineIndexesOf, schemaAnswer, searchModelOf, withSchema, type StoredNode } from '../testing/search-fixtures.js';

const RELATIONSHIPS = [
  { type: 'LINKED', from: 'widget', to: 'widget' },
  { type: 'FOR', from: 'gadget', to: 'widget' },
];
const mapping = searchMappingOf({ entities: RELATED_ENTITIES, relationships: RELATIONSHIPS });
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');

const stored: StoredNode[] = [
  { elementId: '4:s:1', label: 'Widget', properties: { widgetId: 'W-1', ownerName: 'Ivo Lowe', batchRef: 'X-1', ownerRef: 'O-9' } },
  { elementId: '4:s:2', label: 'Gadget', properties: { gadgetId: 'GT-1', widgetRef: 'X-1' } },
  { elementId: '4:s:3', label: 'Widget', properties: { widgetId: 'X-1', batchRef: 'BT-0' } },
];

interface Stored {
  readonly hit: string;
  readonly exact: string;
  readonly type: string;
  readonly direction: 'out' | 'in';
}

/** Answers the context read as the server would for these relationships: one row for each hit that has one, by the positions the request gave. */
function relatedBy(relationships: readonly Stored[]): (call: ExecuteCall) => Promise<ExecuteOutcome> {
  return (call) => {
    const idsOf = (name: string): string[] => (Array.isArray(call.parameters[name]) ? (call.parameters[name] as { stableId: string }[]).map((entry) => entry.stableId) : []);
    const hits = idsOf('hits');
    const exact = idsOf('exact');
    const rows = hits.flatMap((hit, hi) => {
      const found = relationships.find((entry) => entry.hit === hit && exact.includes(entry.exact));
      return found === undefined ? [] : [{ hi, bi: 0, ei: exact.indexOf(found.exact), rtype: found.type, dir: found.direction }];
    });
    return Promise.resolve({ status: 'rows', rows });
  };
}

const BOTH: readonly Stored[] = [
  { hit: 'W-1', exact: 'X-1', type: 'LINKED', direction: 'out' },
  { hit: 'GT-1', exact: 'X-1', type: 'FOR', direction: 'in' },
];

const started = (options: SearchAppOptions = {}) => startSearchApp({ mapping, respond: searchModelOf(stored), context: relatedBy(BOTH), ...options });
const answerOf = (response: { json: () => unknown }): SearchResult => searchResultSchema.parse(response.json());
const body = { sourceId: 'demo', text: 'X-1' };

describe('the relationship context of a related hit', () => {
  it('holds the type, the direction from the hit and the reference of the exact match, for each hit that has one', async () => {
    const { app } = await started();
    const answer = answerOf(await postSearch(app, body));
    const exactRef = answer.exact[0]?.ref;
    expect(answer.related.hits.map((hit) => hit.context)).toEqual([
      { relationshipType: 'LINKED', direction: 'out', with: exactRef },
      { relationshipType: 'FOR', direction: 'in', with: exactRef },
    ]);
    await app.close();
  });

  it('holds nothing for a hit with no stored relationship, and makes the one read for the hits that were given', async () => {
    const { app, executor } = await started({ context: relatedBy([BOTH[0] as Stored]) });
    const answer = answerOf(await postSearch(app, body));
    expect(answer.related.hits.map((hit) => hit.context?.relationshipType)).toEqual(['LINKED', undefined]);
    const [call] = contextCalls(executor);
    expect(contextCalls(executor)).toHaveLength(1);
    expect((call?.parameters['hits'] as { stableId: string }[]).map((entry) => entry.stableId)).toEqual(['W-1', 'GT-1']);
    expect((call?.parameters['exact'] as { stableId: string }[]).map((entry) => entry.stableId)).toEqual(['X-1']);
    await app.close();
  });

  it('makes no context read, and holds none, with no exact match, no related hit or no mapping row that joins them', async () => {
    const none = await started();
    expect(answerOf(await postSearch(none.app, { sourceId: 'demo', text: 'nothing' })).related.hits).toEqual([]);
    expect(contextCalls(none.executor)).toHaveLength(0);
    const noExact = await started({ respond: searchModelOf(stored.filter((node) => node.properties['widgetId'] !== 'X-1')) });
    expect(answerOf(await postSearch(noExact.app, body)).related.hits.every((hit) => hit.context === undefined)).toBe(true);
    expect(contextCalls(noExact.executor)).toHaveLength(0);
    const unjoined = await startSearchApp({ mapping: searchMappingOf({ entities: RELATED_ENTITIES, relationships: [] }), respond: searchModelOf(stored), context: relatedBy(BOTH) });
    expect(answerOf(await postSearch(unjoined.app, body)).related.hits.every((hit) => hit.context === undefined)).toBe(true);
    expect(contextCalls(unjoined.executor)).toHaveLength(0);
    await Promise.all([none.app.close(), noExact.app.close(), unjoined.app.close()]);
  });

  it('makes no context read when the selection leaves out the exact group, or narrows the types so it holds no hit', async () => {
    const related = await started();
    expect(answerOf(await postSearch(related.app, { ...body, matchModes: ['related'] })).related.hits.every((hit) => hit.context === undefined)).toBe(true);
    expect(contextCalls(related.executor)).toHaveLength(0);
    const narrowed = await started();
    expect(answerOf(await postSearch(narrowed.app, { ...body, entityTypes: ['gadget'] })).related.hits.every((hit) => hit.context === undefined)).toBe(true);
    expect(contextCalls(narrowed.executor)).toHaveLength(0);
    await Promise.all([related.app.close(), narrowed.app.close()]);
  });

  it('makes no context read when the exact group or the related group failed', async () => {
    const model = searchModelOf(stored);
    for (const failing of ['entity-search', 'entity-related']) {
      const { app, executor } = await started({ respond: (call) => (call.templateId === failing ? Promise.resolve({ status: 'timeout' }) : model(call)) });
      const answer = answerOf(await postSearch(app, body));
      expect(answer.failures.map((failure) => failure.group)).toEqual([failing === 'entity-search' ? 'exact' : 'related']);
      expect(contextCalls(executor)).toHaveLength(0);
      await app.close();
    }
  });

  it('makes no context read for a type-ahead request', async () => {
    const { app, executor } = await started();
    await postSearch(app, { sourceId: 'demo', text: 'X-', typeahead: true });
    expect(contextCalls(executor)).toHaveLength(0);
    await app.close();
  });

  it('records the one read as one event of its own, with no value, and gives the answer no value of either record', async () => {
    const { app, events } = await started();
    const answer = answerOf(await postSearch(app, { ...body, mask: true }));
    expect(events.filter((event) => event.action === 'entity.search_context')).toEqual([expect.objectContaining({ result: 'success', sourceId: 'demo' })]);
    expect(JSON.stringify(events)).not.toContain('X-1');
    for (const hit of answer.related.hits) expect(Object.keys(hit.context ?? {}).sort()).toEqual(['direction', 'relationshipType', 'with']);
    await app.close();
  });
});

describe('the types whose pairs are left out of the context read for want of a stable-ID index', () => {
  const without = (...properties: string[]) => onlineIndexesOf(source).filter((row) => !properties.includes(row.property));

  it('names the type with the property and the reason, reads the pairs of the other type, and never answers "no relationship" for it', async () => {
    const { app, executor } = await startSearchApp({ mapping, ownSchema: true, respond: withSchema(() => schemaAnswer(without('gadgetId')), searchModelOf(stored)), context: relatedBy(BOTH) });
    const answer = answerOf(await postSearch(app, body));
    expect(answer.related.context).toEqual({ disabledTypes: [{ entityType: 'gadget', property: 'gadgetId', reason: 'index-unavailable', typeSearched: false }] });
    expect(answer.related.hits.map((hit) => hit.context?.relationshipType)).toEqual(['LINKED', undefined]);
    const [call] = contextCalls(executor);
    expect((call?.parameters['hits'] as { stableId: string }[]).map((entry) => entry.stableId)).toEqual(['W-1']);
    await app.close();
  });

  it('makes no read when the type of every exact match has no index, and names the type', async () => {
    const { app, executor } = await startSearchApp({ mapping, ownSchema: true, respond: withSchema(() => schemaAnswer(without('widgetId')), searchModelOf(stored)), context: relatedBy(BOTH) });
    const answer = answerOf(await postSearch(app, body));
    expect(answer.related.context?.disabledTypes.map((entry) => entry.entityType)).toEqual(['widget']);
    expect(contextCalls(executor)).toHaveLength(0);
    await app.close();
  });

  it('reads the pairs unguarded when the login cannot list indexes', async () => {
    const model = searchModelOf(stored);
    const { app, executor } = await startSearchApp({
      mapping,
      ownSchema: true,
      context: relatedBy(BOTH),
      respond: (call) => (call.templateId === 'schema-indexes' ? Promise.resolve({ status: 'unavailable', reason: 'refused' }) : model(call)),
    });
    const answer = answerOf(await postSearch(app, body));
    expect(answer.related.hits.map((hit) => hit.context?.relationshipType)).toEqual(['LINKED', 'FOR']);
    expect(contextCalls(executor)).toHaveLength(1);
    await app.close();
  });
});

describe('a relationship context read that fails', () => {
  const TIMEOUT: ExecuteOutcome = { status: 'timeout' };
  const base = searchModelOf(stored);

  async function failed(options: SearchAppOptions) {
    const parts = await started(options);
    const response = await postSearch(parts.app, body);
    return { ...parts, response };
  }

  const keepsEverything = (answer: SearchResult): void => {
    expect(answer.exact.map((node) => node.ref.stableId)).toEqual(['X-1']);
    expect(answer.counts.exact).toEqual({ value: 1, quality: 'exact', scope: 'search:exact' });
    expect(answer.related.hits.map((hit) => hit.node.ref.stableId)).toEqual(['W-1', 'GT-1']);
    expect(answer.related.count).toEqual({ value: 2, quality: 'exact', scope: 'search:related' });
    expect(answer.related.hits.every((hit) => hit.context === undefined)).toBe(true);
  };

  it('keeps every group and every hit, holds no context, and names the context read with its code and the budget of a timeout', async () => {
    const { response, events } = await failed({ context: () => Promise.resolve(TIMEOUT) });
    expect(response.statusCode).toBe(200);
    const answer = answerOf(response);
    keepsEverything(answer);
    expect(answer.failures).toEqual([{ group: 'context', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }]);
    expect(events.filter((event) => event.action === 'entity.search_context')).toEqual([expect.objectContaining({ result: 'failed' })]);
  });

  it('names INTERNAL_ERROR for an unexpected error of the read', async () => {
    const { response } = await failed({ context: () => Promise.reject(new Error('the adapter broke')) });
    const answer = answerOf(response);
    keepsEverything(answer);
    expect(answer.failures).toEqual([{ group: 'context', code: 'INTERNAL_ERROR' }]);
  });

  it('names RATE_LIMITED for a rate limit raised inside the read', async () => {
    const limited: TemplateDefinition = { ...relatedContextTemplate, normalize: (): never => { throw new AppError('RATE_LIMITED'); } };
    const catalog = createTemplateCatalog({ templates: [schemaIndexesTemplate, searchExactTemplate, searchRelatedTemplate, searchFacetsTemplate, limited] });
    const { response } = await failed({ catalog, context: relatedBy(BOTH) });
    const answer = answerOf(response);
    keepsEverything(answer);
    expect(answer.failures).toEqual([{ group: 'context', code: 'RATE_LIMITED' }]);
  });

  it('names SOURCE_BUSY when the source refuses the one read', async () => {
    let reads = 0;
    // the context read is the last of the reads: the schema, the exact, the related and the facet reads come before it
    const busyLast = { acquireRead: () => Promise.resolve(++reads === 5 ? ({ status: 'busy' } as const) : ({ status: 'granted', lease: { release: () => Promise.resolve() } } as const)) };
    const { response } = await failed({ coordinator: busyLast, context: relatedBy(BOTH) });
    const answer = answerOf(response);
    expect(answer.failures).toEqual([{ group: 'context', code: 'SOURCE_BUSY' }]);
    keepsEverything(answer);
  });

  it('fails the whole search for a failure that means the same for every read', async () => {
    const { response } = await failed({ context: () => Promise.resolve({ status: 'unavailable', reason: 'unreachable' }) });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('SOURCE_UNAVAILABLE');
  });

  it('fails the whole search, with no partial line, when the request is cancelled while the read runs', async () => {
    const node = (stableId: string): GraphNode => ({ ref: { sourceId: 'demo', entityType: 'widget', stableId }, display: { title: stableId, type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
    const page = (stableId: string): GatePage => ({ items: [{ nodes: [node(stableId)], edges: [], unreferenced: [], dropped: {}, warnings: [] }], hasMore: false });
    const gate: Gate = {
      run: (request) => (request.templateId === RELATED_CONTEXT_ID ? Promise.reject(new RequestCancelled()) : Promise.resolve(page(request.templateId === 'entity-search' ? 'X-1' : 'W-1'))),
      runMany: () => Promise.reject(new Error('not used')),
    };
    const access = { require: () => Promise.resolve(), admit: () => undefined, readable: (call: { readonly sourceIds: readonly string[] }) => Promise.resolve([...call.sourceIds]) };
    const service = createSearchService({ gate, mapping, access });
    await expect(service.search({ traceId: 'tr-1', principal: LOCAL_PRINCIPAL, sourceId: 'demo', text: 'X-1', mask: false, signal: new AbortController().signal })).rejects.toBeInstanceOf(RequestCancelled);
  });
});

