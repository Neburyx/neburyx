import { searchResultSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ExecuteOutcome } from '../gate/executor.js';
import { evidenceCalls, postSearch, RELATED_ENTITIES, searchCalls, searchMappingOf, startSearchApp } from '../testing/search-app.js';
import { onlineIndexesOf, relationshipRangeIndex, schemaAnswer, searchModelOf, type IndexRow, type StoredNode, type StoredRelationship } from '../testing/search-fixtures.js';

const TEXT = 'REC-1';
const body = { sourceId: 'demo', text: TEXT };
const widgetNode: StoredNode = { elementId: '4:s:1', label: 'Widget', properties: { widgetId: 'W-1' } };
const gadgetNode: StoredNode = { elementId: '4:s:2', label: 'Gadget', properties: { gadgetId: 'GT-1' } };
const link = (type: string, id: string): StoredRelationship => ({ elementId: `5:r:${id}`, type, from: widgetNode, to: gadgetNode, properties: { linkId: id, recordId: TEXT } });
const stored = [link('MADE_FROM', 'L-1'), link('USED_IN', 'L-2')];

const TWO_ROWS = [
  { type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId'] },
  { type: 'USED_IN', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId'] },
];

function started(options: { readonly relationships?: readonly unknown[]; readonly entities?: readonly unknown[]; readonly schema?: (indexes: IndexRow[]) => ExecuteOutcome; readonly usability?: { isUsable: () => boolean } } = {}) {
  const mapping = searchMappingOf({ entities: options.entities ?? RELATED_ENTITIES, relationships: options.relationships ?? TWO_ROWS });
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const model = searchModelOf([widgetNode, gadgetNode], () => undefined, stored);
  const online = onlineIndexesOf(source);
  const schema = options.schema ?? ((indexes) => schemaAnswer(indexes));
  return startSearchApp({
    mapping,
    ownSchema: true,
    respond: (call) => (call.templateId === 'schema-indexes' ? Promise.resolve(schema(online)) : model(call)),
    ...(options.usability === undefined ? {} : { usability: options.usability }),
  });
}

const without = (rows: readonly IndexRow[], type: string) => rows.filter((row) => !(row.entityType === 'RELATIONSHIP' && row.name === type));
const answerOf = async (app: Awaited<ReturnType<typeof started>>['app']) => searchResultSchema.parse((await postSearch(app, body)).json());

describe('a relationship row whose evidence index is not online', () => {
  it.each([
    ['missing', (rows: IndexRow[]) => without(rows, 'USED_IN')],
    ['building', (rows: IndexRow[]) => [...without(rows, 'USED_IN'), relationshipRangeIndex('USED_IN', 'recordId', 'POPULATING')]],
    ['failed', (rows: IndexRow[]) => [...without(rows, 'USED_IN'), relationshipRangeIndex('USED_IN', 'recordId', 'FAILED')]],
  ])('is left out whole and named, with no statement naming it, when its index is %s, and the other row is still searched', async (_name, change) => {
    const { app, executor } = await started({ schema: (rows) => schemaAnswer(change(rows)) });
    const answer = await answerOf(app);
    expect(answer.evidence.disabledRelationshipTypes).toEqual([{ relationshipType: 'USED_IN', from: 'widget', to: 'gadget', reason: 'index-unavailable' }]);
    expect(answer.evidence.hits.map((hit) => hit.supports.type)).toEqual(['MADE_FROM']);
    expect(answer.evidence.searchable).toBe(true);
    expect(evidenceCalls(executor)).toHaveLength(1);
    expect(evidenceCalls(executor)[0]?.cypher).not.toContain('USED_IN');
    await app.close();
  });

  it('runs no evidence statement and records no evidence event when every row is left out, and the group is not searchable', async () => {
    const { app, executor, events } = await started({ schema: (rows) => schemaAnswer(rows.filter((row) => row.entityType !== 'RELATIONSHIP')) });
    const answer = await answerOf(app);
    expect(evidenceCalls(executor)).toHaveLength(0);
    expect(events.some((event) => event.action === 'entity.search_evidence')).toBe(false);
    expect(answer.evidence.searchable).toBe(false);
    expect(answer.evidence.disabledRelationshipTypes.map((row) => row.reason)).toEqual(['index-unavailable', 'index-unavailable']);
    expect(searchCalls(executor)).toHaveLength(1);
    await app.close();
  });
});

describe('a relationship row with no stable ID, and a mapping with no evidence property', () => {
  it('does not search a row that has an evidence property and no stable ID, and names it with the reason no-stable-id', async () => {
    const { app, executor } = await started({ relationships: [{ type: 'MADE_FROM', from: 'widget', to: 'gadget', evidence: ['recordId'] }] });
    const answer = await answerOf(app);
    expect(answer.evidence.disabledRelationshipTypes).toEqual([{ relationshipType: 'MADE_FROM', from: 'widget', to: 'gadget', reason: 'no-stable-id' }]);
    expect(answer.evidence.searchable).toBe(false);
    expect(evidenceCalls(executor)).toHaveLength(0);
    await app.close();
  });

  it('makes no read and records no event for the group when the mapping has no evidence property', async () => {
    const { app, executor, events } = await started({ relationships: [{ type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId' }] });
    const answer = await answerOf(app);
    expect(answer.evidence).toEqual({ hits: [], count: { value: 0, quality: 'exact', scope: 'search:evidence' }, searchable: false, disabledRelationshipTypes: [] });
    expect(evidenceCalls(executor)).toHaveLength(0);
    expect(events.some((event) => event.action === 'entity.search_evidence')).toBe(false);
    await app.close();
  });
});

describe('a mapping whose only searchable group is the evidence group', () => {
  it('runs the exact group through the gate with every stage but the read and keeps its event, reads the schema once and the evidence group once', async () => {
    const entities = [
      { type: 'widget', label: 'Widget', stable_id: 'widgetId' },
      { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
    ];
    const { app, executor, events } = await started({ entities, relationships: [TWO_ROWS[0]] });
    const answer = await answerOf(app);
    expect(answer.searchable).toBe(false);
    expect(answer.evidence.hits.map((hit) => hit.supports.stableId)).toEqual(['L-1']);
    expect(searchCalls(executor)).toHaveLength(0);
    expect(executor.calls.filter((call) => call.templateId === 'schema-indexes')).toHaveLength(1);
    expect(evidenceCalls(executor)).toHaveLength(1);
    expect(answer.facets).toEqual({ searchable: true, total: { value: 0, quality: 'exact', scope: 'search:facet:total' }, entityType: [], matchMode: [{ mode: 'evidence', count: { value: expect.any(Number), quality: 'exact', scope: 'search:facet:matchMode' } }] });
    expect(events.map((event) => `${event.action} ${event.result}`).sort()).toEqual(['entity.search success', 'entity.search_evidence success', 'entity.search_facets success', 'source.schema_indexes success']);
    await app.close();
  });
});

describe('where the guard cannot say, and when the schema read fails', () => {
  it('searches the evidence group unguarded, and adds no field to the answer, when the source refuses to list indexes', async () => {
    const { app, executor } = await started({ schema: () => ({ status: 'unavailable', reason: 'refused' }) });
    const answer = await answerOf(app);
    expect(answer.evidence.disabledRelationshipTypes).toEqual([]);
    expect(answer.evidence.hits.map((hit) => hit.supports.type).sort()).toEqual(['MADE_FROM', 'USED_IN']);
    expect(Object.keys(answer.evidence).sort()).toEqual(['count', 'disabledRelationshipTypes', 'hits', 'searchable']);
    expect(evidenceCalls(executor)).toHaveLength(1);
    await app.close();
  });

  it.each([
    ['a timeout', { status: 'timeout' } as const, 504],
    ['a source that is down', { status: 'unavailable', reason: 'unreachable' } as const, 503],
    ['an answer that cannot be read', { status: 'rows', rows: [{ indexes: 'nonsense', truncated: false }] } as const, 500],
    ['a truncated answer', schemaAnswer([], true), 500],
  ])('answers the error of the schema read for %s, makes no data read and audits every run as failed', async (_name, outcome, status) => {
    const { app, executor, events } = await started({ schema: () => outcome });
    const response = await postSearch(app, body);
    expect(response.statusCode).toBe(status);
    expect(executor.calls.map((call) => call.templateId)).toEqual(['schema-indexes']);
    expect(events.filter((event) => event.action.startsWith('entity.search')).every((event) => event.result === 'failed')).toBe(true);
    await app.close();
  });
});
