import { searchResultSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { evidenceCalls, postSearch, RELATED_ENTITIES, relatedCalls, searchCalls, searchMappingOf, startSearchApp } from '../testing/search-app.js';
import { onlineIndexesOf, relationshipRangeIndex, relationshipTextIndex, schemaAnswer, searchModelOf, withSchema, type StoredNode, type StoredRelationship } from '../testing/search-fixtures.js';

const RELATIONSHIPS = [
  { type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId', 'docId'] },
  { type: 'MADE_FROM', from: 'widget', to: 'part', stable_id: 'linkId' },
];
const mapping = searchMappingOf({ entities: RELATED_ENTITIES, relationships: RELATIONSHIPS });
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');

const widgetNode: StoredNode = { elementId: '4:s:1', label: 'Widget', properties: { widgetId: 'W-1', ownerName: 'Ivo Lowe', batchRef: 'BT-0' } };
const gadgetNode: StoredNode = { elementId: '4:s:2', label: 'Gadget', properties: { gadgetId: 'GT-1' } };
const partNode: StoredNode = { elementId: '4:s:3', label: 'Part', properties: { partId: 'P-1' } };
const link = (id: string, properties: Record<string, unknown>, from: StoredNode = widgetNode, to: StoredNode = gadgetNode): StoredRelationship => ({ elementId: `5:r:${id}`, type: 'MADE_FROM', from, to, properties: { linkId: id, ...properties } });

const started = (relationships: readonly StoredRelationship[], options: Parameters<typeof startSearchApp>[0] = {}) =>
  startSearchApp({ mapping, respond: searchModelOf([widgetNode, gadgetNode, partNode], () => undefined, relationships), ...options });

const answerOf = async (app: Awaited<ReturnType<typeof started>>['app'], text: string, extra: Record<string, unknown> = {}) => {
  const response = await postSearch(app, { sourceId: 'demo', text, ...extra });
  expect(response.statusCode).toBe(200);
  return searchResultSchema.parse(response.json());
};

describe('POST /v1/search/entities with evidence records', () => {
  it('returns the relationship that carries the record ID, by its reference, with the values of all its evidence properties and an exact count', async () => {
    const { app } = await started([link('L-1', { recordId: 'REC-1', docId: 'DOC-9' })]);
    const answer = await answerOf(app, 'REC-1');
    expect(answer.evidence.hits).toEqual([{ supports: { sourceId: 'demo', type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' }, records: [{ sourceRecordId: 'REC-1' }, { sourceRecordId: 'DOC-9' }], rules: [] }]);
    expect(answer.evidence.count).toEqual({ value: 1, quality: 'exact', scope: 'search:evidence' });
    expect(answer.evidence.searchable).toBe(true);
    expect(answer.evidence.disabledRelationshipTypes).toEqual([]);
    await app.close();
  });

  it('makes one evidence read through its own template and audit action, with the one schema read the other groups share', async () => {
    const { app, executor, events } = await started([link('L-1', { recordId: 'REC-1' })]);
    await answerOf(app, 'REC-1');
    expect(evidenceCalls(executor)).toHaveLength(1);
    expect(searchCalls(executor)).toHaveLength(1);
    expect(relatedCalls(executor)).toHaveLength(1);
    expect(executor.calls.filter((call) => call.templateId === 'schema-indexes')).toHaveLength(1);
    expect(events.map((event) => `${event.action} ${event.result}`).sort()).toEqual(['entity.search success', 'entity.search_evidence success', 'entity.search_facets success', 'entity.search_related success', 'source.schema_indexes success']);
    await app.close();
  });

  it('costs one acquisition of the read seam for the evidence group, beside one for the schema read and one for each of the other groups, and releases each', async () => {
    let acquired = 0;
    let released = 0;
    const coordinator = { acquireRead: () => (acquired += 1, Promise.resolve({ status: 'granted' as const, lease: { release: () => (released += 1, Promise.resolve()) } })) };
    const { app, executor } = await started([link('L-1', { recordId: 'REC-1' })], { coordinator });
    await answerOf(app, 'REC-1');
    expect(executor.calls.map((call) => call.templateId).sort()).toEqual(['entity-related', 'entity-search', 'relationship-evidence', 'schema-indexes', 'search-facets']);
    expect(acquired).toBe(5);
    expect(released).toBe(5);
    await app.close();
  });

  it('costs no acquisition for an evidence group that is disabled or not searched', async () => {
    const count = async (options: Parameters<typeof startSearchApp>[0]) => {
      let acquired = 0;
      const coordinator = { acquireRead: () => (acquired += 1, Promise.resolve({ status: 'granted' as const, lease: { release: () => Promise.resolve() } })) };
      const { app } = await startSearchApp({ ...options, coordinator });
      await answerOf(app, 'REC-1');
      await app.close();
      return acquired;
    };
    const model = searchModelOf([widgetNode, gadgetNode, partNode], () => undefined, [link('L-1', { recordId: 'REC-1' })]);
    const withoutEvidenceIndex = withSchema(() => schemaAnswer(onlineIndexesOf(source).filter((index) => index.entityType !== 'RELATIONSHIP')), model);
    expect(await count({ mapping, ownSchema: true, respond: withoutEvidenceIndex })).toBe(4);
    const bare = searchMappingOf({ entities: RELATED_ENTITIES, relationships: [{ type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId' }] });
    expect(await count({ mapping: bare, respond: model })).toBe(4);
  });

  it('answers no hit and an exact zero for a text no relationship carries', async () => {
    const { app } = await started([link('L-1', { recordId: 'REC-1' })]);
    const answer = await answerOf(app, 'REC-404');
    expect(answer.evidence.hits).toEqual([]);
    expect(answer.evidence.count).toEqual({ value: 0, quality: 'exact', scope: 'search:evidence' });
    await app.close();
  });

  it('does not match a relationship of another pair of entity types that the row does not give evidence for', async () => {
    const { app } = await started([link('L-2', { recordId: 'REC-2' }, widgetNode, partNode), link('L-3', { recordId: 'REC-2' })]);
    const answer = await answerOf(app, 'REC-2');
    expect(answer.evidence.hits.map((hit) => hit.supports.stableId)).toEqual(['L-3']);
    await app.close();
  });

  it('keeps the exact group, the related group and the evidence group apart when one text matches an entity and a relationship', async () => {
    const entity: StoredNode = { elementId: '4:s:9', label: 'Widget', properties: { widgetId: 'REC-1' } };
    const { app } = await startSearchApp({ mapping, respond: searchModelOf([widgetNode, gadgetNode, entity], () => undefined, [link('L-1', { recordId: 'REC-1' })]) });
    const answer = await answerOf(app, 'REC-1');
    expect(answer.exact.map((node) => node.ref.stableId)).toEqual(['REC-1']);
    expect(answer.counts.exact).toEqual({ value: 1, quality: 'exact', scope: 'search:exact' });
    expect(answer.related.hits).toEqual([]);
    expect(answer.evidence.hits).toHaveLength(1);
    expect(answer.evidence.count).toEqual({ value: 1, quality: 'exact', scope: 'search:evidence' });
    await app.close();
  });

  it('returns the same relationships with the mask asked for and not, holds no property of an endpoint, and leaves an endpoint that is an exact match in the exact group', async () => {
    const { app } = await started([link('L-1', { recordId: 'W-1' })]);
    const [plain, masked] = [await answerOf(app, 'W-1', { mask: false }), await answerOf(app, 'W-1', { mask: true })];
    expect(masked.evidence).toEqual(plain.evidence);
    expect(JSON.stringify(plain.evidence)).not.toContain('Ivo Lowe');
    expect(JSON.stringify(plain.evidence)).not.toContain('GT-1');
    expect(plain.exact.map((node) => node.ref.stableId)).toEqual(['W-1']);
    expect(masked.exact.map((node) => node.ref.stableId)).toEqual(['W-1']);
    await app.close();
  });

  it('reads a RANGE-indexed property as the text and the integer and a TEXT-indexed one as the text only', async () => {
    const indexes = [...onlineIndexesOf(source).filter((index) => !(index.entityType === 'RELATIONSHIP' && index.property === 'docId')), relationshipTextIndex('MADE_FROM', 'docId')];
    const { app, executor } = await started([link('L-1', { recordId: 'REC-1' })], { ownSchema: true, respond: withSchema(() => schemaAnswer(indexes), searchModelOf([widgetNode, gadgetNode], () => undefined, [link('L-1', { recordId: 'REC-1' })])) });
    await answerOf(app, 'REC-1');
    const [call] = evidenceCalls(executor);
    expect(call?.cypher).toContain('USING RANGE INDEX SEEK r:`MADE_FROM`(`recordId`) WHERE r.`recordId` IN [$text, $textInteger]');
    expect(call?.cypher).toContain('USING TEXT INDEX r:`MADE_FROM`(`docId`) WHERE r.`docId` = $text');
    expect(call?.cypher).not.toContain('r.`docId` IN');
    await app.close();
  });

  it('keeps the typed text out of the audit events, the log lines and the error of a failed evidence read', async () => {
    const text = 'needle-4711';
    const model = searchModelOf([widgetNode, gadgetNode], () => undefined, [link('L-1', { recordId: text })]);
    const { app, events, lines } = await started([], { respond: (call) => (call.templateId === 'relationship-evidence' ? Promise.reject(new Error(`could not read ${text}`)) : model(call)) });
    const response = await postSearch(app, { sourceId: 'demo', text });
    expect(JSON.stringify(response.json())).not.toContain(text);
    expect(JSON.stringify(events)).not.toContain(text);
    expect(lines.join('\n')).not.toContain(text);
    await app.close();
  });

  it('is one hit when the relationship carries the text in two evidence properties', async () => {
    const { app } = await started([link('L-1', { recordId: 'REC-1', docId: 'REC-1' })]);
    const answer = await answerOf(app, 'REC-1');
    expect(answer.evidence.hits).toHaveLength(1);
    expect(answer.evidence.hits[0]?.records).toEqual([{ sourceRecordId: 'REC-1' }]);
    expect(answer.evidence.count).toMatchObject({ value: 1 });
    await app.close();
  });

  it('reads neither the related nor the evidence group for a type-ahead request, and says the evidence group is not searched', async () => {
    const { app, executor } = await started([link('L-1', { recordId: 'REC-1' })]);
    const answer = await answerOf(app, 'RE', { typeahead: true });
    expect(evidenceCalls(executor)).toHaveLength(0);
    expect(relatedCalls(executor)).toHaveLength(0);
    expect(answer.evidence).toEqual({ hits: [], count: { value: 0, quality: 'exact', scope: 'search:evidence' }, searchable: false, disabledRelationshipTypes: [] });
    await app.close();
  });

  it('adds the rows left out by the three runs, by reason, and warns from the sum', async () => {
    const idless: StoredNode = { elementId: '4:s:79', label: 'Gadget', properties: {} };
    const model = searchModelOf([widgetNode, gadgetNode], () => undefined, [link('L-1', { recordId: 'REC-1' }), link('L-9', { recordId: 'REC-1' }, widgetNode, idless)]);
    const orphan = plainNode(['Mystery'], { id: 'M-1' }, '4:s:77');
    const nameless = plainNode(['Widget'], { ownerName: 'No Id' }, '4:s:78');
    const respond = (call: Parameters<typeof model>[0]) => {
      if (call.templateId === 'entity-search') return Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: 'W-1' }, '4:s:1'), nameless));
      if (call.templateId === 'entity-related') return Promise.resolve(entityRows(orphan));
      return model(call);
    };
    const relatedMapping = searchMappingOf({ entities: RELATED_ENTITIES, relationships: RELATIONSHIPS });
    const { app } = await startSearchApp({ mapping: relatedMapping, respond });
    const answer = await answerOf(app, 'REC-1');
    expect(answer.evidence.hits.map((hit) => hit.supports.stableId)).toEqual(['L-1']);
    expect(answer.dropped).toEqual({ 'not-mapped': 2, 'ambiguous-type': 0, 'no-stable-id': 2 });
    expect(answer.warnings).toHaveLength(2);
    await app.close();
  });
});
