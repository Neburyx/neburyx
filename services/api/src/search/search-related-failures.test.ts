import { searchResultSchema, type SearchResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { createTemplateCatalog } from '../gate/catalog.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { schemaIndexesTemplate } from '../gate/templates/schema-indexes.js';
import { searchExactTemplate } from '../gate/templates/search-exact.js';
import { searchRelatedTemplate } from '../gate/templates/search-related.js';
import type { AuditEvent } from '../seams/seams.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { postSearch, RELATED_ENTITIES, searchMappingOf, startSearchApp, type SearchAppOptions } from '../testing/search-app.js';
import { searchModelOf, type StoredNode } from '../testing/search-fixtures.js';

const TEXT = 'needle-9042';
const mapping = searchMappingOf({ entities: RELATED_ENTITIES });
const stored: StoredNode[] = [
  { elementId: '4:s:1', label: 'Widget', properties: { widgetId: TEXT, batchRef: TEXT } },
  { elementId: '4:s:2', label: 'Gadget', properties: { gadgetId: 'GT-1', widgetRef: TEXT } },
];
const model = searchModelOf(stored);

const failing =
  (templateId: string, outcome: ExecuteOutcome | Error) =>
  (call: ExecuteCall): Promise<ExecuteOutcome> => {
    if (call.templateId !== templateId) return model(call);
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  };

async function searched(options: SearchAppOptions) {
  const parts = await startSearchApp({ mapping, respond: model, ...options });
  const response = await postSearch(parts.app, { sourceId: 'demo', text: TEXT });
  return { ...parts, response };
}

const answerOf = (json: unknown): SearchResult => searchResultSchema.parse(json);

describe('one group whose read fails while the other answers', () => {
  it('keeps the exact group and its true count when the related read times out, with an unknown related count and the budget of the timeout', async () => {
    const { response, events, lines } = await searched({ respond: failing('entity-related', { status: 'timeout' }) });
    expect(response.statusCode).toBe(200);
    const answer = answerOf(response.json());
    expect(answer.exact.map((node) => node.ref.stableId)).toEqual([TEXT]);
    expect(answer.counts.exact).toEqual({ value: 1, quality: 'exact', scope: 'search:exact' });
    expect(answer.related).toMatchObject({ hits: [], searchable: true, count: { quality: 'unknown', scope: 'search:related' } });
    expect(answer.related.count).not.toHaveProperty('value');
    expect(answer.failures).toEqual([{ group: 'related', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }]);
    expect(events.filter((event) => event.action.startsWith('entity.search')).map((event) => `${event.action} ${event.result}`).sort()).toEqual(['entity.search success', 'entity.search_related failed']);
    expect(JSON.stringify(answerOf(response.json()).failures)).not.toContain(TEXT);
    expect(JSON.stringify(events)).not.toContain(TEXT);
    expect(lines.join('\n')).not.toContain(TEXT);
  });

  it('keeps the related group and its true count when the exact read times out, and does not show the exact group as empty', async () => {
    const { response, events } = await searched({ respond: failing('entity-search', { status: 'timeout' }) });
    expect(response.statusCode).toBe(200);
    const answer = answerOf(response.json());
    expect(answer.exact).toEqual([]);
    expect(answer.counts.exact).toEqual({ quality: 'unknown', scope: 'search:exact' });
    expect(answer.failures).toEqual([{ group: 'exact', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }]);
    expect(answer.related.hits.map((hit) => hit.node.ref.stableId).sort()).toEqual(['GT-1', TEXT]);
    expect(answer.related.count).toMatchObject({ value: 2, quality: 'exact' });
    expect(events.filter((event) => event.action.startsWith('entity.search')).map((event) => `${event.action} ${event.result}`).sort()).toEqual(['entity.search failed', 'entity.search_related success']);
  });

  it('answers a group read that fails with an unexpected error as a failure of that group only', async () => {
    const { response } = await searched({ respond: failing('entity-related', new Error('the adapter broke')) });
    expect(response.statusCode).toBe(200);
    expect(answerOf(response.json()).failures).toEqual([{ group: 'related', code: 'INTERNAL_ERROR' }]);
  });

  it('answers a busy source for the one read it refuses as a failure of that group only', async () => {
    let reads = 0;
    const busyThird = { acquireRead: () => Promise.resolve(++reads === 3 ? ({ status: 'busy' } as const) : ({ status: 'granted', lease: { release: () => Promise.resolve() } } as const)) };
    const { response } = await searched({ coordinator: busyThird });
    expect(response.statusCode).toBe(200);
    const answer = answerOf(response.json());
    expect(answer.failures).toHaveLength(1);
    expect(answer.failures[0]).toMatchObject({ code: 'SOURCE_BUSY' });
    const [failure] = answer.failures;
    const other = failure?.group === 'exact' ? answer.related.count : answer.counts.exact;
    expect(other.quality).toBe('exact');
  });

  it('answers a rate limit raised inside the related run as a failure of that group only, audited as failed', async () => {
    const limited = { ...searchRelatedTemplate, normalize: (): never => { throw new AppError('RATE_LIMITED'); } };
    const catalog = createTemplateCatalog({ templates: [schemaIndexesTemplate, searchExactTemplate, limited] });
    const { response, events } = await searched({ catalog });
    expect(response.statusCode).toBe(200);
    expect(answerOf(response.json()).failures).toEqual([{ group: 'related', code: 'RATE_LIMITED' }]);
    expect(events.filter((event) => event.action === 'entity.search_related')).toEqual([expect.objectContaining({ result: 'failed' })]);
  });

  it('keeps the diagnostics of the group that answered, unchanged, and adds nothing for the one that failed', async () => {
    const withLoss = (call: ExecuteCall): Promise<ExecuteOutcome> => {
      if (call.templateId === 'entity-related') return Promise.resolve({ status: 'timeout' });
      if (call.templateId === 'entity-search') return Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: TEXT }, '4:e:1'), plainNode(['Nothing'], { x: 1 }, '4:e:2')));
      return model(call);
    };
    const { response } = await searched({ respond: withLoss });
    const answer = answerOf(response.json());
    expect(answer.dropped).toEqual({ 'not-mapped': 1, 'ambiguous-type': 0, 'no-stable-id': 0 });
    expect(answer.warnings).toHaveLength(1);
  });
});

describe('a failure that fails the whole search', () => {
  it.each([
    ['a source that is down, raised by the related read', failing('entity-related', { status: 'unavailable', reason: 'unreachable' }), false, 503, 'SOURCE_UNAVAILABLE'],
    ['a source that is down, raised by the exact read', failing('entity-search', { status: 'unavailable', reason: 'unreachable' }), false, 503, 'SOURCE_UNAVAILABLE'],
    ['a schema read that times out', (call: ExecuteCall) => (call.templateId === 'schema-indexes' ? Promise.resolve<ExecuteOutcome>({ status: 'timeout' }) : model(call)), true, 504, 'QUERY_TIMEOUT'],
  ])('answers %s as the error of the search', async (_name, respond, ownSchema, status, code) => {
    const { response, executor } = await searched({ ownSchema, respond });
    expect(response.statusCode).toBe(status);
    expect(response.json().error).toMatchObject({ code, traceId: expect.any(String) });
    expect(response.json()).not.toHaveProperty('failures');
    if (code === 'QUERY_TIMEOUT') expect(executor.calls.filter((call) => call.templateId !== 'schema-indexes')).toEqual([]);
  });

  it('answers a request the related run refuses as INVALID_REQUEST for the whole search, with the refusal audited', async () => {
    const catalog = createTemplateCatalog({ templates: [schemaIndexesTemplate, searchExactTemplate, searchRelatedTemplate], isEnabled: (id) => id !== 'entity-related' });
    const { response, events } = await searched({ catalog });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(events.filter((event) => event.action === 'entity.search_related')).toEqual([expect.objectContaining({ result: 'refused' })]);
  });

  it('answers the exact error when both groups were read and both failed with an error of their own', async () => {
    const both = (call: ExecuteCall): Promise<ExecuteOutcome> => {
      if (call.templateId === 'entity-search') return Promise.resolve({ status: 'timeout' });
      if (call.templateId === 'entity-related') return Promise.reject(new Error('the read could not be run'));
      return model(call);
    };
    const { response } = await searched({ respond: both });
    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe('QUERY_TIMEOUT');
  });

  it('answers an error that means the same for every group even when the other read gave a group failure first', async () => {
    const mixed = (call: ExecuteCall): Promise<ExecuteOutcome> => {
      if (call.templateId === 'entity-search') return Promise.resolve({ status: 'timeout' });
      if (call.templateId === 'entity-related') return Promise.resolve({ status: 'unavailable', reason: 'unreachable' });
      return model(call);
    };
    const { response } = await searched({ respond: mixed });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('SOURCE_UNAVAILABLE');
    const typeahead = await startSearchApp({ mapping, respond: (call) => (call.templateId === 'entity-search' ? Promise.resolve({ status: 'timeout' }) : call.templateId === 'entity-search-prefix' ? Promise.resolve({ status: 'unavailable', reason: 'unreachable' }) : model(call)) });
    const answered = await postSearch(typeahead.app, { sourceId: 'demo', text: TEXT, typeahead: true });
    expect(answered.statusCode).toBe(503);
    expect(answered.json().error.code).toBe('SOURCE_UNAVAILABLE');
    await typeahead.app.close();
  });

  it('answers the error of the only group that was read, whichever it is', async () => {
    const onlyRelated = searchMappingOf({ entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['ownerName'], reference: ['batchRef'], pii: [{ property: 'ownerName', class: 'name' }] }] });
    const relatedOnly = await startSearchApp({ mapping: onlyRelated, respond: failing('entity-related', { status: 'timeout' }) });
    const first = await postSearch(relatedOnly.app, { sourceId: 'demo', text: TEXT, mask: true });
    expect(first.statusCode).toBe(504);
    expect(first.json().error.code).toBe('QUERY_TIMEOUT');
    await relatedOnly.app.close();
    const plain = searchMappingOf();
    const exactOnly = await startSearchApp({ mapping: plain, respond: failing('entity-search', { status: 'unavailable', reason: 'unreachable' }) });
    const second = await postSearch(exactOnly.app, { sourceId: 'demo', text: TEXT });
    expect(second.statusCode).toBe(503);
    expect(second.json().error.code).toBe('SOURCE_UNAVAILABLE');
    await exactOnly.app.close();
  });
});

describe('the reads after the exact read', () => {
  it('reads the startsWith group and not the related group for a type-ahead request, which answers the related group as not searched', async () => {
    const parts = await startSearchApp({ mapping, respond: model });
    const answer = answerOf((await postSearch(parts.app, { sourceId: 'demo', text: TEXT, typeahead: true })).json());
    expect(parts.executor.calls.map((call) => call.templateId).filter((id) => id !== 'schema-indexes')).toEqual(['entity-search', 'entity-search-prefix']);
    expect(answer.related).toEqual({ hits: [], count: { value: 0, quality: 'exact', scope: 'search:related' }, searchable: false, disabledTypes: [] });
    expect(answer.startsWith).toBeDefined();
    await parts.app.close();
  });

  it('reads no other group when the exact read fails with an error that means the same for every group', async () => {
    const parts = await startSearchApp({ mapping, respond: failing('entity-search', { status: 'unavailable', reason: 'unreachable' }) });
    const response = await postSearch(parts.app, { sourceId: 'demo', text: TEXT, typeahead: true });
    expect(response.statusCode).toBe(503);
    expect(parts.executor.calls.filter((call) => call.templateId !== 'schema-indexes').map((call) => call.templateId)).toEqual(['entity-search']);
    await parts.app.close();
  });
});
