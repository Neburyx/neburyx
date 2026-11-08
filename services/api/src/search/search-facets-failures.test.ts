import { FACET_SCOPES, searchResultSchema, type SearchResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { postSearch, RELATED_ENTITIES, searchMappingOf, startSearchApp, type SearchAppOptions } from '../testing/search-app.js';
import { searchModelOf, type StoredNode, type StoredRelationship } from '../testing/search-fixtures.js';

const TEXT = 'needle-9042';
const RELATIONSHIPS = [{ type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId'] }];
const mapping = searchMappingOf({ entities: RELATED_ENTITIES, relationships: RELATIONSHIPS });
const widgetNode: StoredNode = { elementId: '4:s:1', label: 'Widget', properties: { widgetId: TEXT, batchRef: TEXT } };
const gadgetNode: StoredNode = { elementId: '4:s:2', label: 'Gadget', properties: { gadgetId: 'GT-1', widgetRef: TEXT } };
const link: StoredRelationship = { elementId: '5:r:1', type: 'MADE_FROM', from: widgetNode, to: gadgetNode, properties: { linkId: 'L-1', recordId: TEXT } };
const model = searchModelOf([widgetNode, gadgetNode], () => undefined, [link]);

const failing =
  (failures: Readonly<Record<string, ExecuteOutcome | Error>>) =>
  (call: ExecuteCall): Promise<ExecuteOutcome> => {
    const failure = failures[call.templateId];
    if (failure === undefined) return model(call);
    return failure instanceof Error ? Promise.reject(failure) : Promise.resolve(failure);
  };

async function searched(options: SearchAppOptions) {
  const parts = await startSearchApp({ mapping, respond: model, ...options });
  const response = await postSearch(parts.app, { sourceId: 'demo', text: TEXT });
  return { ...parts, response };
}

const answerOf = (json: unknown): SearchResult => searchResultSchema.parse(json);
const FAILED = { searchable: true, total: { quality: 'unknown', scope: FACET_SCOPES.total }, entityType: [], matchMode: [] };
const TIMEOUT: ExecuteOutcome = { status: 'timeout' };
const searchEvents = (events: readonly { readonly action: string; readonly result: string }[]) => events.filter((event) => event.action.startsWith('entity.search')).map((event) => `${event.action} ${event.result}`).sort();

describe('a facet read that fails while the groups answer', () => {
  it.each([
    ['QUERY_TIMEOUT', TIMEOUT, { group: 'facets', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }],
    ['SOURCE_BUSY', new AppError('SOURCE_BUSY'), { group: 'facets', code: 'SOURCE_BUSY' }],
    ['RATE_LIMITED', new AppError('RATE_LIMITED'), { group: 'facets', code: 'RATE_LIMITED' }],
    ['INTERNAL_ERROR', new Error('the adapter broke'), { group: 'facets', code: 'INTERNAL_ERROR' }],
  ])('names the facet read for %s, keeps every group with its true count and answers the failed shape', async (_code, failure, named) => {
    const { response, events, lines } = await searched({ respond: failing({ 'search-facets': failure }) });
    expect(response.statusCode).toBe(200);
    const answer = answerOf(response.json());
    expect(answer.failures).toEqual([named]);
    expect(answer.facets).toEqual(FAILED);
    expect(answer.facets).not.toHaveProperty('total.value');
    expect(answer.counts.exact).toEqual({ value: 1, quality: 'exact', scope: 'search:exact' });
    expect(answer.related.count).toEqual({ value: 2, quality: 'exact', scope: 'search:related' });
    expect(answer.evidence.count).toEqual({ value: 1, quality: 'exact', scope: 'search:evidence' });
    expect(answer.filters).toEqual({ entityTypes: [], matchModes: [] });
    expect(searchEvents(events)).toEqual(['entity.search success', 'entity.search_context success', 'entity.search_evidence success', 'entity.search_facets failed', 'entity.search_related success']);
    expect(JSON.stringify([answer.failures, events])).not.toContain(TEXT);
    expect(lines.join('\n')).not.toContain(TEXT);
  });
});

describe('a result group that fails while the facet read answers', () => {
  it('keeps the facet counts and names the group', async () => {
    const { response } = await searched({ respond: failing({ 'entity-related': TIMEOUT }) });
    const answer = answerOf(response.json());
    expect(answer.failures).toEqual([{ group: 'related', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }]);
    expect(answer.facets).toMatchObject({ searchable: true, total: { quality: 'exact' } });
    expect(answer.related.count).toEqual({ quality: 'unknown', scope: 'search:related' });
  });

  it('fails the search with the first group error when every result group that was read fails, whether the facet read answers or fails', async () => {
    for (const probe of [model, failing({ 'search-facets': TIMEOUT })]) {
      const respond = (call: ExecuteCall): Promise<ExecuteOutcome> =>
        call.templateId === 'search-facets' ? probe(call) : failing({ 'entity-search': TIMEOUT, 'entity-related': new Error('broke'), 'relationship-evidence': new Error('broke too') })(call);
      const { response } = await searched({ respond });
      expect(response.statusCode).toBe(504);
      expect(response.json().error.code).toBe('QUERY_TIMEOUT');
    }
  });

  it('names the related group and the facet read, and keeps the exact group, when only those two fail', async () => {
    const { response, events } = await searched({ respond: failing({ 'entity-related': TIMEOUT, 'search-facets': new Error('broke') }) });
    const answer = answerOf(response.json());
    expect(answer.failures).toEqual([{ group: 'related', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }, { group: 'facets', code: 'INTERNAL_ERROR' }]);
    expect(answer.counts.exact).toEqual({ value: 1, quality: 'exact', scope: 'search:exact' });
    expect(answer.evidence.count).toMatchObject({ value: 1 });
    expect(searchEvents(events)).toEqual(['entity.search success', 'entity.search_evidence success', 'entity.search_facets failed', 'entity.search_related failed']);
  });

  it('answers the exact and the facet failure together when the exact group fails, keeping the related group', async () => {
    const { response } = await searched({ respond: failing({ 'entity-search': TIMEOUT, 'search-facets': TIMEOUT }) });
    const answer = answerOf(response.json());
    expect(answer.failures.map((failure) => failure.group)).toEqual(['exact', 'facets']);
    expect(answer.related.hits.length).toBeGreaterThan(0);
  });
});

describe('a failure that fails the whole search', () => {
  it.each([
    ['a source that is down, raised by the facet read', failing({ 'search-facets': { status: 'unavailable', reason: 'unreachable' } }), false, 503, 'SOURCE_UNAVAILABLE'],
    ['a schema read that times out', (call: ExecuteCall) => (call.templateId === 'schema-indexes' ? Promise.resolve<ExecuteOutcome>(TIMEOUT) : model(call)), true, 504, 'QUERY_TIMEOUT'],
    ['a schema read that is busy', (call: ExecuteCall) => (call.templateId === 'schema-indexes' ? Promise.reject(new AppError('SOURCE_BUSY')) : model(call)), true, 503, 'SOURCE_BUSY'],
  ])('answers %s as the error of the search', async (_name, respond, ownSchema, status, code) => {
    const { response, executor } = await searched({ ownSchema, respond });
    expect(response.statusCode).toBe(status);
    expect(response.json().error).toMatchObject({ code });
    expect(response.json()).not.toHaveProperty('failures');
    if (ownSchema) expect(executor.calls.filter((call) => call.templateId !== 'schema-indexes')).toEqual([]);
  });

  it('lets a read that was started settle before it answers the whole-search error of the facet read, and leaves none running', async () => {
    let release: (outcome: ExecuteOutcome) => void = () => undefined;
    const held = new Promise<ExecuteOutcome>((resolve) => (release = resolve));
    let heldCall: ExecuteCall | undefined;
    let answered = false;
    const respond = (call: ExecuteCall): Promise<ExecuteOutcome> => {
      if (call.templateId === 'search-facets') return Promise.resolve({ status: 'unavailable', reason: 'unreachable' });
      if (call.templateId === 'entity-related') {
        heldCall = call;
        return held;
      }
      return model(call);
    };
    const parts = await startSearchApp({ mapping, respond });
    const pending = postSearch(parts.app, { sourceId: 'demo', text: TEXT }).then((response) => ((answered = true), response));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);
    if (heldCall === undefined) throw new Error('the related read was not started');
    release(await model(heldCall));
    const response = await pending;
    expect(answered).toBe(true);
    expect(response.statusCode).toBe(503);
    await parts.app.close();
  });

  it('answers the error of a facet read the gate refuses, with the refusal audited, and not a group failure', async () => {
    const { response, events } = await searched({ respond: failing({ 'search-facets': new AppError('INVALID_REQUEST') }) });
    expect(response.statusCode).toBe(400);
    expect(events.filter((event) => event.action === 'entity.search_facets')).toEqual([expect.objectContaining({ result: 'refused' })]);
  });
});

describe('what the facet read leaves to the groups', () => {
  it('reads the targets that exist when only the evidence group has one and the facet read fails: the exact group goes through the gate and the answer is the failed shape', async () => {
    const entities = [
      { type: 'widget', label: 'Widget', stable_id: 'widgetId' },
      { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
    ];
    const parts = await startSearchApp({ mapping: searchMappingOf({ entities, relationships: RELATIONSHIPS }), respond: failing({ 'search-facets': TIMEOUT }) });
    const response = await postSearch(parts.app, { sourceId: 'demo', text: TEXT });
    expect(response.statusCode).toBe(200);
    const answer = answerOf(response.json());
    expect(answer.failures).toEqual([{ group: 'facets', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }]);
    expect(answer.evidence.hits).toHaveLength(1);
    expect(answer.searchable).toBe(false);
    await parts.app.close();
  });

  it('applies the failure rules only when the read fails after an index vanished: the test makes the read fail as a server error would', async () => {
    const { response } = await searched({ respond: failing({ 'search-facets': new Error('the index is gone') }) });
    expect(answerOf(response.json()).failures).toEqual([{ group: 'facets', code: 'INTERNAL_ERROR' }]);
  });
});
