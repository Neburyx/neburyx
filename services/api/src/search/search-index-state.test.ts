import { searchResultSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { postSearch, searchCalls, startSearchApp, widgets, type SearchAppOptions } from '../testing/search-app.js';
import { answering } from '../testing/search-app.js';
import { rangeIndex, schemaAnswer, textIndex, withSchema, type IndexRow } from '../testing/search-fixtures.js';

const ALL_ONLINE: readonly IndexRow[] = [rangeIndex('Widget', 'widgetId', 'ONLINE', true), rangeIndex('Widget', 'ownerName'), rangeIndex('Gadget', 'gadgetId')];

function started(indexes: () => ExecuteOutcome, options: SearchAppOptions = {}) {
  return startSearchApp({ ...options, ownSchema: true, respond: withSchema(indexes, answering(widgets(1))) });
}

const ids = (calls: readonly ExecuteCall[]): string[] => calls.map((call) => call.templateId);
const body = { sourceId: 'demo', text: 'W-001' };
const statementsNaming = (calls: readonly ExecuteCall[], label: string): number => calls.filter((call) => call.cypher.includes(`\`${label}\``)).length;

describe('the indexes of a search are read at the start of each request', () => {
  it('reads the schema once, then the data once, and gives the one snapshot to the gate run (no second schema read)', async () => {
    const { app, executor, events } = await started(() => schemaAnswer(ALL_ONLINE));
    const response = await postSearch(app, body);
    expect(response.statusCode).toBe(200);
    expect(ids(executor.calls)).toEqual(['schema-indexes', 'entity-search', 'search-facets']);
    expect(events.map((event) => `${event.action} ${event.result}`)).toEqual(['source.schema_indexes success', 'entity.search success', 'entity.search_facets success']);
    await app.close();
  });

  it('reads the schema again for the next search, and keeps nothing between requests', async () => {
    let answers = 0;
    const { app, executor } = await started(() => (answers++ === 0 ? schemaAnswer(ALL_ONLINE) : schemaAnswer([])));
    expect(searchResultSchema.parse((await postSearch(app, body)).json()).disabledTypes).toEqual([]);
    const second = searchResultSchema.parse((await postSearch(app, body)).json());
    expect(second.disabledTypes.map((disabled) => disabled.entityType).sort()).toEqual(['gadget', 'widget', 'widget']);
    expect(ids(executor.calls)).toEqual(['schema-indexes', 'entity-search', 'search-facets', 'schema-indexes']);
    await app.close();
  });
});

describe('a property whose search index is not online is not searched, and the rest of its type is', () => {
  it.each([
    ['an index being built', [rangeIndex('Widget', 'widgetId', 'ONLINE', true), rangeIndex('Widget', 'ownerName', 'POPULATING'), rangeIndex('Gadget', 'gadgetId')], 'index-building'],
    ['an index that has failed', [rangeIndex('Widget', 'widgetId', 'ONLINE', true), rangeIndex('Widget', 'ownerName', 'FAILED'), rangeIndex('Gadget', 'gadgetId')], 'index-failed'],
    ['an index that is gone (no index of that property)', [rangeIndex('Widget', 'widgetId', 'ONLINE', true), rangeIndex('Gadget', 'gadgetId')], 'index-unavailable'],
  ])('names the property for %s with the reason %s, searches the type by its other property, and no statement names the property', async (_name, indexes, reason) => {
    const { app, executor } = await started(() => schemaAnswer(indexes));
    const result = searchResultSchema.parse((await postSearch(app, body)).json());
    expect(result.disabledTypes).toEqual([{ entityType: 'widget', property: 'ownerName', reason, typeSearched: true }]);
    expect(result.searchable).toBe(true);
    const [search] = searchCalls(executor);
    expect(search?.cypher).toContain('MATCH (n:`Widget`) WHERE n.`widgetId`');
    expect(search?.cypher).not.toContain('ownerName');
    expect(statementsNaming(searchCalls(executor), 'Gadget')).toBe(1);
    await app.close();
  });

  it('names a type as not searched, with the reason of each of its properties, when none of them has an online index', async () => {
    const { app, executor } = await started(() => schemaAnswer([rangeIndex('Widget', 'widgetId', 'POPULATING', true), rangeIndex('Widget', 'ownerName', 'FAILED'), rangeIndex('Gadget', 'gadgetId')]));
    const result = searchResultSchema.parse((await postSearch(app, body)).json());
    expect(result.disabledTypes).toEqual([
      { entityType: 'widget', property: 'widgetId', reason: 'index-building', typeSearched: false },
      { entityType: 'widget', property: 'ownerName', reason: 'index-failed', typeSearched: false },
    ]);
    expect(result.searchable).toBe(true);
    expect(statementsNaming(searchCalls(executor), 'Widget')).toBe(0);
    expect(statementsNaming(searchCalls(executor), 'Gadget')).toBe(1);
    await app.close();
  });

  it('runs no data statement when every type is left out: the schema read is the only statement, and one audit event is recorded for the search', async () => {
    const { app, executor, events } = await started(() => schemaAnswer([]));
    const result = searchResultSchema.parse((await postSearch(app, body)).json());
    expect(result.exact).toEqual([]);
    expect(result.searchable).toBe(false);
    expect(result.disabledTypes.map((disabled) => [disabled.entityType, disabled.property, disabled.typeSearched])).toEqual([['widget', 'widgetId', false], ['widget', 'ownerName', false], ['gadget', 'gadgetId', false]]);
    expect(ids(executor.calls)).toEqual(['schema-indexes']);
    expect(events.filter((event) => event.action === 'entity.search')).toEqual([expect.objectContaining({ result: 'success' })]);
    await app.close();
  });
});

describe('the form of each branch follows the index that serves it', () => {
  const cypherOf = async (indexes: readonly IndexRow[]): Promise<string> => {
    const { app, executor } = await started(() => schemaAnswer(indexes));
    await postSearch(app, body);
    await app.close();
    return searchCalls(executor)[0]?.cypher ?? '';
  };

  it('matches the text and the integer for a RANGE index or a constraint, the text only for a TEXT index, and the RANGE form when both exist', async () => {
    const text = await cypherOf([rangeIndex('Widget', 'widgetId', 'ONLINE', true), rangeIndex('Widget', 'ownerName'), textIndex('Gadget', 'gadgetId')]);
    expect(text).toContain('MATCH (n:`Widget`) WHERE n.`widgetId` IN [$text, $textInteger] AND ($cursor IS NULL OR elementId(n) > $cursor.after) WITH n ORDER BY elementId(n) LIMIT $limit + 1 RETURN n');
    expect(text).toContain('MATCH (n:`Gadget`) WHERE n.`gadgetId` = $text AND ($cursor IS NULL OR elementId(n) > $cursor.after) WITH n ORDER BY elementId(n) LIMIT $limit + 1 RETURN n');
    const both = await cypherOf([...ALL_ONLINE, textIndex('Gadget', 'gadgetId')]);
    expect(both).toContain('MATCH (n:`Gadget`) WHERE n.`gadgetId` IN [$text, $textInteger] AND ($cursor IS NULL OR elementId(n) > $cursor.after) WITH n ORDER BY elementId(n) LIMIT $limit + 1 RETURN n');
  });
});

describe('where the guard cannot say', () => {
  it('searches every type as before when the source refuses to list indexes, disables none, and reads the schema once: the one case it cannot protect', async () => {
    const { app, executor } = await started(() => ({ status: 'unavailable', reason: 'refused' }));
    const result = searchResultSchema.parse((await postSearch(app, body)).json());
    expect(result.disabledTypes).toEqual([]);
    expect(result.searchable).toBe(true);
    expect(ids(executor.calls)).toEqual(['schema-indexes', 'entity-search', 'search-facets']);
    await app.close();
  });

  // the service reads once and hands the failure to the search run, which fails with that same error inside its audited stages, after authorization, and makes no other statement
  it.each([
    ['a schema read that times out', () => ({ status: 'timeout' }) as const, 504, 'QUERY_TIMEOUT'],
    ['a source that is down', () => ({ status: 'unavailable', reason: 'unreachable' }) as const, 503, 'SOURCE_UNAVAILABLE'],
    ['an answer that cannot be read', () => ({ status: 'rows', rows: [{ nothing: true }] }) as const, 503, 'SOURCE_UNAVAILABLE'],
    ['an answer that is truncated', () => schemaAnswer(ALL_ONLINE, true), 503, 'SOURCE_UNAVAILABLE'],
  ])('answers %s with its error and runs no data read, so no scan can follow', async (_name, answer, status, code) => {
    const { app, executor, events } = await started(answer);
    const response = await postSearch(app, body);
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(ids(executor.calls)).toEqual(['schema-indexes']);
    expect(searchCalls(executor)).toEqual([]);
    expect(events.filter((event) => event.action === 'entity.search')).toHaveLength(1);
  });

  it.each([
    ['cannot be read', () => ({ status: 'rows', rows: [{ nothing: true }] }) as const],
    ['is truncated', () => schemaAnswer(ALL_ONLINE, true)],
  ])('refuses the search when the list of indexes %s, with the reason index-list-unreadable, not retryable, audited as refused', async (_name, answer) => {
    const { app, events } = await started(answer);
    const response = await postSearch(app, body);
    expect(response.json().error).toMatchObject({ code: 'SOURCE_UNAVAILABLE', retryable: false, details: { reason: 'index-list-unreadable' } });
    expect(events.filter((event) => event.action === 'entity.search')).toEqual([expect.objectContaining({ result: 'refused' })]);
    await app.close();
  });
});

describe('a failed schema read is the failure of the search', () => {
  it.each([
    ['answers the next read', () => schemaAnswer(ALL_ONLINE)],
    ['says the login cannot list indexes', () => ({ status: 'unavailable', reason: 'refused' }) as const],
  ])('keeps the first failure when the source %s, and makes no data read', async (_name, later) => {
    let reads = 0;
    const { app, executor, events } = await started(() => (++reads === 1 ? ({ status: 'timeout' } as const) : later()));
    const response = await postSearch(app, body);
    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe('QUERY_TIMEOUT');
    expect(reads).toBe(1);
    expect(searchCalls(executor)).toEqual([]);
    expect(events.filter((event) => event.action === 'entity.search')).toEqual([expect.objectContaining({ result: 'failed' })]);
    await app.close();
  });
});

describe('what the guard leaves to the other rules', () => {
  it('gives the error of the data read when it fails after the schema read, and records nothing of the types', async () => {
    const { app, executor } = await startSearchApp({ ownSchema: true, respond: withSchema(() => schemaAnswer(ALL_ONLINE), () => Promise.resolve({ status: 'timeout' })) });
    const response = await postSearch(app, body);
    expect(response.statusCode).toBe(504);
    expect(ids(executor.calls)).toEqual(['schema-indexes', 'entity-search', 'search-facets']);
    await app.close();
  });
});

describe('the schema read follows the authorization of the request', () => {
  it('makes no statement at all for a principal the policy refuses, not even the schema read', async () => {
    const { app, executor } = await started(() => schemaAnswer(ALL_ONLINE), { policy: { authorizeSource: () => Promise.resolve({ allowed: false as const, reason: 'denied' }) } });
    expect((await postSearch(app, body)).statusCode).toBe(404);
    expect(executor.calls).toEqual([]);
    await app.close();
  });
});
