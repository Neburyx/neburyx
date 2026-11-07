import { FACET_SCOPES, searchResultSchema, type SearchResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { facetCalls, postSearch, RELATED_ENTITIES, searchMappingOf, startSearchApp } from '../testing/search-app.js';
import { onlineIndexesOf, schemaAnswer, searchModelOf, withSchema, type StoredNode, type StoredRelationship } from '../testing/search-fixtures.js';

const TEXT = 'X-1';
const RELATIONSHIPS = [
  { type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId', 'docId'] },
  { type: 'NO_ID', from: 'widget', to: 'gadget', evidence: ['recordId'] },
];

const widget = (index: number, properties: Record<string, unknown> = {}): StoredNode => ({ elementId: `4:w:${index}`, label: 'Widget', properties: { widgetId: `W-${String(index).padStart(3, '0')}`, ...properties } });
const gadget = (index: number, properties: Record<string, unknown> = {}): StoredNode => ({ elementId: `4:g:${index}`, label: 'Gadget', properties: { gadgetId: `GT-${String(index).padStart(3, '0')}`, ...properties } });
const referencing = (count: number): StoredNode[] => Array.from({ length: count }, (_, index) => gadget(index + 1, { widgetRef: TEXT }));
const anchors = { from: widget(900), to: gadget(900) };
const carrying = (count: number, property = 'recordId'): StoredRelationship[] =>
  Array.from({ length: count }, (_, index) => ({ elementId: `5:r:${index + 1}`, type: 'MADE_FROM', from: anchors.from, to: anchors.to, properties: { linkId: `L-${String(index + 1).padStart(3, '0')}`, [property]: TEXT } }));

async function searched(stored: readonly StoredNode[], relationships: readonly StoredRelationship[] = [], overrides: Record<string, unknown> = {}, options: Parameters<typeof startSearchApp>[0] = {}, request: Record<string, unknown> = {}) {
  const mapping = searchMappingOf({ entities: RELATED_ENTITIES, relationships: RELATIONSHIPS, ...overrides });
  const parts = await startSearchApp({ mapping, respond: searchModelOf([...stored, anchors.from, anchors.to], () => undefined, relationships), ...options });
  const response = await postSearch(parts.app, { sourceId: 'demo', text: TEXT, ...request });
  const answer: SearchResult | undefined = response.statusCode === 200 ? searchResultSchema.parse(response.json()) : undefined;
  return { response, parts, answer };
}

const facetsOf = (answer: SearchResult | undefined) => {
  if (answer?.facets === undefined || !answer.facets.searchable) throw new Error('the answer has no facets');
  return answer.facets;
};
const modeOf = (answer: SearchResult | undefined, mode: string) => facetsOf(answer).matchMode.find((entry) => entry.mode === mode)?.count;
const typeOf = (answer: SearchResult | undefined, type: string) => facetsOf(answer).entityType.find((entry) => entry.entityType === type)?.count;
const exactCount = (value: number, scope: string) => ({ value, quality: 'exact', scope });

describe('the match modes and the total of the facets', () => {
  it('counts the referencing entities and the supporting relationships, as the groups count them, and the entities matched by any target', async () => {
    const { answer, parts } = await searched(referencing(2), carrying(4));
    expect(modeOf(answer, 'related')).toEqual(exactCount(2, FACET_SCOPES.matchMode));
    expect(modeOf(answer, 'evidence')).toEqual(exactCount(4, FACET_SCOPES.matchMode));
    expect(modeOf(answer, 'exact')).toEqual(exactCount(0, FACET_SCOPES.matchMode));
    expect(answer?.related.count).toEqual(exactCount(2, 'search:related'));
    expect(answer?.evidence.count).toEqual(exactCount(4, 'search:evidence'));
    expect(facetsOf(answer).total).toEqual(exactCount(2, FACET_SCOPES.total));
    expect(typeOf(answer, 'gadget')).toEqual(exactCount(2, FACET_SCOPES.entityType));
    await parts.app.close();
  });

  it('counts an entity matched exactly and by reference once in the total and in its type, and once in each of the two modes', async () => {
    const both = gadget(1, { gadgetId: TEXT, widgetRef: TEXT });
    const { answer, parts } = await searched([both]);
    expect(typeOf(answer, 'gadget')).toEqual(exactCount(1, FACET_SCOPES.entityType));
    expect(facetsOf(answer).total).toEqual(exactCount(1, FACET_SCOPES.total));
    expect(modeOf(answer, 'exact')).toEqual(exactCount(1, FACET_SCOPES.matchMode));
    expect(modeOf(answer, 'related')).toEqual(exactCount(1, FACET_SCOPES.matchMode));
    expect(answer?.counts.exact).toMatchObject({ value: 1 });
    expect(answer?.related.count).toMatchObject({ value: 1 });
    await parts.app.close();
  });

  it.each([
    [24, 'exact', 24],
    [25, 'exact', 25],
    [26, 'lowerBound', 25],
  ])('counts %i matches of each of the related and the evidence mode, and of the total, as %s with the value %i', async (matches, quality, value) => {
    const { answer, parts } = await searched(referencing(matches), carrying(matches));
    expect(modeOf(answer, 'related')).toEqual({ value, quality, scope: FACET_SCOPES.matchMode });
    expect(modeOf(answer, 'evidence')).toEqual({ value, quality, scope: FACET_SCOPES.matchMode });
    expect(facetsOf(answer).total).toEqual({ value, quality, scope: FACET_SCOPES.total });
    expect(typeOf(answer, 'gadget')).toEqual({ value, quality, scope: FACET_SCOPES.entityType });
    await parts.app.close();
  });

  it('counts an entity type whose related index is gone by its exact matches only, and the related group still names the type', async () => {
    const mapping = searchMappingOf({ entities: RELATED_ENTITIES, relationships: RELATIONSHIPS });
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('the mapping has no source');
    const noGadgetReference = onlineIndexesOf(source).filter((index) => !(index.entityType === 'NODE' && index.name === 'Gadget' && index.property === 'widgetRef'));
    const stored = [gadget(1, { gadgetId: TEXT }), gadget(2, { widgetRef: TEXT }), gadget(3, { widgetRef: TEXT })];
    const respond = withSchema(() => schemaAnswer(noGadgetReference), searchModelOf([...stored, anchors.from, anchors.to], () => undefined, []));
    const { answer, parts } = await searched(stored, [], {}, { ownSchema: true, respond });
    expect(answer?.related.disabledTypes).toEqual([{ entityType: 'gadget', reason: 'index-unavailable' }]);
    expect(typeOf(answer, 'gadget')).toEqual(exactCount(1, FACET_SCOPES.entityType));
    expect(modeOf(answer, 'related')).toEqual(exactCount(0, FACET_SCOPES.matchMode));
    expect(facetCalls(parts.executor)[0]?.cypher).not.toContain('widgetRef');
    await parts.app.close();
  });

  it('has no evidence probe for a relationship row without a stable ID, which the evidence group names as before', async () => {
    const { answer, parts } = await searched([], carrying(1));
    expect(answer?.evidence.disabledRelationshipTypes).toEqual([{ relationshipType: 'NO_ID', from: 'widget', to: 'gadget', reason: 'no-stable-id' }]);
    expect(facetCalls(parts.executor)[0]?.cypher).not.toContain('NO_ID');
    await parts.app.close();
  });
});

describe('what a facet counts that a group cannot show', () => {
  it('counts a record with no stable ID, which the group drops and says so', async () => {
    const nameless: StoredNode = { elementId: '4:w:n', label: 'Widget', properties: { ownerName: TEXT } };
    const { answer, parts } = await searched([nameless, widget(1, { ownerName: TEXT })]);
    expect(typeOf(answer, 'widget')).toEqual(exactCount(2, FACET_SCOPES.entityType));
    expect(answer?.exact).toHaveLength(1);
    expect(answer?.dropped).toMatchObject({ 'no-stable-id': 1 });
    await parts.app.close();
  });

  it('counts a node with two mapped labels in each of its types, which the group drops as ambiguous', async () => {
    const both: StoredNode = { elementId: '4:x:1', label: 'Widget', alsoLabels: ['Gadget'], properties: { widgetId: 'W-1', gadgetId: 'GT-1', ownerName: TEXT, gadgetRegion: TEXT } };
    const { answer, parts } = await searched([both], [], { entities: [...RELATED_ENTITIES.slice(0, 1), { ...RELATED_ENTITIES[1], search: ['gadgetId', 'gadgetRegion'] }, ...RELATED_ENTITIES.slice(2)] });
    expect(typeOf(answer, 'widget')).toEqual(exactCount(1, FACET_SCOPES.entityType));
    expect(typeOf(answer, 'gadget')).toEqual(exactCount(1, FACET_SCOPES.entityType));
    expect(facetsOf(answer).total).toEqual(exactCount(1, FACET_SCOPES.total));
    expect(answer?.exact).toEqual([]);
    expect(answer?.dropped).toMatchObject({ 'ambiguous-type': 1 });
    await parts.app.close();
  });

  it('counts two records of one stable ID, which the group merges into one and flags, without a new count or a drop', async () => {
    const first = widget(1, { widgetId: 'W-SAME', ownerName: TEXT, batchRef: 'A' });
    const second: StoredNode = { ...first, elementId: '4:w:dup', properties: { ...first.properties, batchRef: 'B' } };
    const { answer, parts } = await searched([first, second]);
    expect(typeOf(answer, 'widget')).toEqual(exactCount(2, FACET_SCOPES.entityType));
    expect(answer?.exact).toHaveLength(1);
    expect(answer?.exact[0]?.qualityFlags).toContain('conflicting-duplicate');
    expect(answer?.dropped).toEqual({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });
    await parts.app.close();
  });
});

describe('masking and the facets', () => {
  it('leaves a personal-data search or reference property out of every probe and counts only the others', async () => {
    const stored = [widget(1, { ownerName: TEXT, ownerRef: TEXT }), widget(2, { batchRef: TEXT })];
    const open = await searched(stored, [], {}, {}, { mask: false });
    expect(facetCalls(open.parts.executor)[0]?.cypher).toContain('ownerName');
    expect(typeOf(open.answer, 'widget')).toEqual(exactCount(2, FACET_SCOPES.entityType));
    const masked = await searched(stored, [], {}, {}, { mask: true });
    const statement = facetCalls(masked.parts.executor)[0]?.cypher ?? '';
    expect(statement).not.toContain('ownerName');
    expect(statement).not.toContain('ownerRef');
    expect(statement).toContain('batchRef');
    expect(typeOf(masked.answer, 'widget')).toEqual(exactCount(1, FACET_SCOPES.entityType));
    await open.parts.app.close();
    await masked.parts.app.close();
  });

  it('runs only the evidence probe when every entity property is personal data and an evidence row is eligible, and none when nothing is left', async () => {
    const entities = [
      { type: 'widget', label: 'Widget', stable_id: 'widgetId', search: ['ownerName'], reference: ['ownerRef'], pii: [{ property: 'ownerName', class: 'name' }, { property: 'ownerRef', class: 'text' }] },
      { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
    ];
    const withEvidence = await searched([], carrying(3), { entities }, {}, { mask: true });
    expect(withEvidence.answer?.facets).toEqual({ searchable: true, total: exactCount(0, FACET_SCOPES.total), entityType: [], matchMode: [{ mode: 'evidence', count: exactCount(3, FACET_SCOPES.matchMode) }] });
    expect(facetCalls(withEvidence.parts.executor)).toHaveLength(1);
    const none = await searched([], [], { entities, relationships: [] }, {}, { mask: true });
    expect(none.answer?.facets).toEqual({ searchable: false });
    expect(facetCalls(none.parts.executor)).toEqual([]);
    await withEvidence.parts.app.close();
    await none.parts.app.close();
  });
});

describe('the evidence probe', () => {
  it('carries the index hint of the evidence group for each form and does not count a relationship between other end types', async () => {
    const other: StoredRelationship = { elementId: '5:r:other', type: 'MADE_FROM', from: anchors.from, to: { elementId: '4:p:1', label: 'Part', properties: { partId: 'P-1' } }, properties: { linkId: 'L-OTHER', recordId: TEXT } };
    const { answer, parts } = await searched([], [...carrying(2), other]);
    const statement = facetCalls(parts.executor)[0]?.cypher ?? '';
    expect(statement).toContain('USING RANGE INDEX SEEK r:`MADE_FROM`(`recordId`) WHERE r.`recordId` IN [$text, $textInteger] RETURN r LIMIT $limit + 1');
    expect(modeOf(answer, 'evidence')).toEqual(exactCount(2, FACET_SCOPES.matchMode));
    await parts.app.close();
  });

  it('is the one evidence read of the mapping row and adds one read slot in all', async () => {
    const { parts } = await searched([], carrying(1));
    expect(parts.executor.calls.map((call) => call.templateId).sort()).toEqual(['entity-related', 'entity-search', 'relationship-evidence', 'schema-indexes', 'search-facets']);
    await parts.app.close();
  });
});

describe('the total', () => {
  it('is a known zero when only relationships match, never counts them, and keeps the evidence number apart', async () => {
    const { answer, parts } = await searched([], carrying(5));
    expect(facetsOf(answer).total).toEqual(exactCount(0, FACET_SCOPES.total));
    expect(modeOf(answer, 'evidence')).toEqual(exactCount(5, FACET_SCOPES.matchMode));
    expect(facetsOf(answer).total.scope).toBe('search:facet:total');
    await parts.app.close();
  });
});
