import { searchResultSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { postSearch, relatedCalls, RELATED_ENTITIES, searchCalls, searchMappingOf, startSearchApp, type SearchAppOptions } from '../testing/search-app.js';
import { onlineIndexesOf, rangeIndex, schemaAnswer, searchModelOf, textIndex, withSchema, type IndexRow, type StoredNode } from '../testing/search-fixtures.js';

const mapping = searchMappingOf({ entities: RELATED_ENTITIES });
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');
const ALL = onlineIndexesOf(source);
const without = (...properties: string[]): IndexRow[] => ALL.filter((row) => !properties.includes(row.property));
const stored: StoredNode[] = [
  { elementId: '4:s:1', label: 'Widget', properties: { widgetId: 'W-1', batchRef: 'X-1', ownerRef: 'O-1' } },
  { elementId: '4:s:2', label: 'Gadget', properties: { gadgetId: 'GT-1', widgetRef: 'X-1' } },
];
const TEXT = 'X-1';
const body = { sourceId: 'demo', text: TEXT };

function started(indexes: () => ExecuteOutcome, options: SearchAppOptions = {}) {
  return startSearchApp({ mapping, ...options, ownSchema: true, respond: withSchema(indexes, searchModelOf(stored)) });
}
const ids = (calls: readonly ExecuteCall[]): string[] => calls.map((call) => call.templateId);
const naming = (calls: readonly ExecuteCall[], label: string): number => calls.filter((call) => call.cypher.includes(`\`${label}\``)).length;

describe('a reference property whose index is not online is left out of the related read', () => {
  it.each([
    ['an index being built', [...without('batchRef', 'ownerRef'), rangeIndex('Widget', 'batchRef', 'POPULATING'), rangeIndex('Widget', 'ownerRef', 'POPULATING')], 'index-building'],
    ['an index that has failed', [...without('batchRef', 'ownerRef'), rangeIndex('Widget', 'batchRef', 'FAILED'), rangeIndex('Widget', 'ownerRef', 'FAILED')], 'index-failed'],
    ['an index that is gone', without('batchRef', 'ownerRef'), 'index-unavailable'],
  ])('names a type none of whose reference properties is read for %s, with each property and the reason %s, reads the other type, and no statement of the related read names the label', async (_name, indexes, reason) => {
    const { app, executor } = await started(() => schemaAnswer(indexes));
    const answer = searchResultSchema.parse((await postSearch(app, body)).json());
    expect(answer.related.disabledTypes).toEqual([
      { entityType: 'widget', property: 'batchRef', reason, typeSearched: false },
      { entityType: 'widget', property: 'ownerRef', reason, typeSearched: false },
    ]);
    expect(answer.related.searchable).toBe(true);
    expect(answer.related.hits.map((hit) => hit.node.ref.stableId)).toEqual(['GT-1']);
    expect(naming(relatedCalls(executor), 'Widget')).toBe(0);
    expect(naming(relatedCalls(executor), 'Gadget')).toBe(1);
    expect(naming(searchCalls(executor), 'Widget')).toBe(1);
    await app.close();
  });

  it('reads a type by its reference property that has an index when the other has none, and names only that one', async () => {
    const { app, executor } = await started(() => schemaAnswer([...without('ownerRef'), rangeIndex('Widget', 'ownerRef', 'POPULATING')]));
    const answer = searchResultSchema.parse((await postSearch(app, body)).json());
    expect(answer.related.disabledTypes).toEqual([{ entityType: 'widget', property: 'ownerRef', reason: 'index-building', typeSearched: true }]);
    expect(answer.related.hits.map((hit) => hit.node.ref.stableId)).toEqual(['W-1', 'GT-1']);
    const [related] = relatedCalls(executor);
    expect(related?.cypher).toContain('n.`batchRef`');
    expect(related?.cypher).not.toContain('ownerRef');
    await app.close();
  });

  it('runs no related statement when every type with an eligible reference target is left out: the exact group answers as it would alone', async () => {
    const { app, executor } = await started(() => schemaAnswer(without('batchRef', 'ownerRef', 'widgetRef')));
    const answer = searchResultSchema.parse((await postSearch(app, { sourceId: 'demo', text: 'W-1' })).json());
    expect(answer.related).toMatchObject({ hits: [], searchable: false });
    expect(answer.related.disabledTypes.map((disabled) => disabled.entityType).sort()).toEqual(['gadget', 'widget', 'widget']);
    expect(relatedCalls(executor)).toEqual([]);
    expect(answer.exact.map((node) => node.ref.stableId)).toEqual(['W-1']);
    expect(answer.searchable).toBe(true);
    await app.close();
  });

  it('does not report a personal-data reference property without an index while masked: it is not an eligible target', async () => {
    const { app, executor } = await started(() => schemaAnswer(without('ownerRef')));
    const answer = searchResultSchema.parse((await postSearch(app, { ...body, mask: true })).json());
    expect(answer.related.disabledTypes).toEqual([]);
    expect(naming(relatedCalls(executor), 'Widget')).toBe(1);
    await app.close();
  });
});

describe('the form of the branch follows the index', () => {
  const statement = async (indexes: IndexRow[]): Promise<string> => {
    const { app, executor } = await started(() => schemaAnswer(indexes));
    await postSearch(app, body);
    await app.close();
    return relatedCalls(executor)[0]?.cypher ?? '';
  };
  const widgetOnly = (...rows: IndexRow[]): IndexRow[] => [...without('batchRef', 'ownerRef', 'widgetRef'), ...rows, rangeIndex('Widget', 'ownerRef'), rangeIndex('Gadget', 'widgetRef')];

  it('uses the value form for a RANGE index, a constraint, and both a RANGE and a TEXT index, and the equality form for a TEXT index only', async () => {
    expect(await statement(widgetOnly(rangeIndex('Widget', 'batchRef')))).toContain('n.`batchRef` IN [$text, $textInteger]');
    expect(await statement(widgetOnly(rangeIndex('Widget', 'batchRef', 'ONLINE', true)))).toContain('n.`batchRef` IN [$text, $textInteger]');
    expect(await statement(widgetOnly(rangeIndex('Widget', 'batchRef'), textIndex('Widget', 'batchRef')))).toContain('n.`batchRef` IN [$text, $textInteger]');
    const textOnly = await statement(widgetOnly(textIndex('Widget', 'batchRef')));
    expect(textOnly).toContain('n.`batchRef` = $text');
    expect(textOnly).not.toContain('n.`batchRef` IN');
  });
});

describe('one schema read serves both groups', () => {
  it('reads the schema once for the request, first, and keeps nothing for the next request', async () => {
    const { app, executor } = await started(() => schemaAnswer(ALL));
    await postSearch(app, body);
    expect(ids(executor.calls).filter((id) => id === 'schema-indexes')).toHaveLength(1);
    expect(ids(executor.calls)[0]).toBe('schema-indexes');
    await postSearch(app, body);
    expect(ids(executor.calls).filter((id) => id === 'schema-indexes')).toHaveLength(2);
    await app.close();
  });

  it('follows the indexes of each group on its own: the exact index lost leaves the related group as it was, and the reverse', async () => {
    const exactLost = await started(() => schemaAnswer(without('widgetId', 'ownerName')));
    const first = searchResultSchema.parse((await postSearch(exactLost.app, body)).json());
    expect(first.disabledTypes.map((disabled) => disabled.entityType)).toEqual(['widget', 'widget']);
    expect(first.related.disabledTypes).toEqual([]);
    expect(relatedCalls(exactLost.executor)).toHaveLength(1);
    await exactLost.app.close();
    const relatedLost = await started(() => schemaAnswer(without('batchRef', 'ownerRef')));
    const second = searchResultSchema.parse((await postSearch(relatedLost.app, body)).json());
    expect(second.related.disabledTypes.map((disabled) => disabled.entityType)).toEqual(['widget', 'widget']);
    expect(second.disabledTypes).toEqual([]);
    expect(searchCalls(relatedLost.executor)).toHaveLength(1);
    await relatedLost.app.close();
  });
});

describe('where the guard cannot say, and when the schema read fails', () => {
  it('searches every group as before, and disables nothing, when the source refuses to list indexes', async () => {
    const { app, executor } = await started(() => ({ status: 'unavailable', reason: 'refused' }));
    const answer = searchResultSchema.parse((await postSearch(app, body)).json());
    expect(answer.related.disabledTypes).toEqual([]);
    expect(answer.disabledTypes).toEqual([]);
    expect(relatedCalls(executor)).toHaveLength(1);
    expect(ids(executor.calls).filter((id) => id === 'schema-indexes')).toHaveLength(1);
    await app.close();
  });

  it.each([
    ['a timeout', { status: 'timeout' } as const, 504],
    ['a source that is down', { status: 'unavailable', reason: 'unreachable' } as const, 503],
    ['an answer that cannot be read', { status: 'rows', rows: [{ indexes: 'nonsense', truncated: false }] } as const, 503],
    ['a truncated answer', schemaAnswer(ALL, true), 503],
  ])('answers the error of the schema read for %s, makes no data read, and audits the search as not made', async (_name, outcome, status) => {
    const { app, executor, events } = await started(() => outcome);
    const response = await postSearch(app, body);
    expect(response.statusCode).toBe(status);
    expect(ids(executor.calls)).toEqual(['schema-indexes']);
    expect(events.filter((event) => event.action.startsWith('entity.search')).every((event) => event.result !== 'success')).toBe(true);
    await app.close();
  });
});
