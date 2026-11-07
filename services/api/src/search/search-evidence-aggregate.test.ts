import { relationshipsOf, searchMoreResultSchema, searchResultSchema, type SearchMoreResult, type SearchResult } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { evidenceCalls, postMore, postSearch, RELATED_ENTITIES, searchMappingOf, startSearchApp } from '../testing/search-app.js';
import { aggregateHits, searchModelOf, storedHits, type StoredNode, type StoredRelationship } from '../testing/search-fixtures.js';

const TEXT = 'REC-1';
const RELATIONSHIPS = [
  { type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId', 'docId'] },
  { type: 'SEEN_WITH', from: 'widget', to: 'gadget', observed_at: 'seenAt', evidence: ['recordId', 'docId'] },
];
const mapping = searchMappingOf({ entities: RELATED_ENTITIES, relationships: RELATIONSHIPS });

const widgetNode: StoredNode = { elementId: '4:s:1', label: 'Widget', properties: { widgetId: 'W-1' } };
const otherWidget: StoredNode = { elementId: '4:s:3', label: 'Widget', properties: { widgetId: 'W-2' } };
const gadgetNode: StoredNode = { elementId: '4:s:2', label: 'Gadget', properties: { gadgetId: 'GT-1' } };
const seen = (index: number, properties: Record<string, unknown> = {}, from: StoredNode = widgetNode): StoredRelationship => ({
  elementId: `5:n:${String(index).padStart(3, '0')}`,
  type: 'SEEN_WITH',
  from,
  to: gadgetNode,
  properties: { recordId: TEXT, ...properties },
});
const made = (id: string, properties: Record<string, unknown>): StoredRelationship => ({ elementId: `5:s:${id}`, type: 'MADE_FROM', from: widgetNode, to: gadgetNode, properties: { linkId: id, ...properties } });

const started = (relationships: readonly StoredRelationship[]) => startSearchApp({ mapping, respond: searchModelOf([widgetNode, otherWidget, gadgetNode], () => undefined, relationships) });

async function answerOf(app: Awaited<ReturnType<typeof started>>['app']): Promise<SearchResult> {
  const response = await postSearch(app, { sourceId: 'demo', text: TEXT });
  expect(response.statusCode).toBe(200);
  return searchResultSchema.parse(response.json());
}

async function moreOf(app: Awaited<ReturnType<typeof started>>['app'], cursor: string): Promise<SearchMoreResult> {
  const response = await postMore(app, { sourceId: 'demo', text: TEXT, group: 'evidence', cursor });
  expect(response.statusCode).toBe(200);
  return searchMoreResultSchema.parse(response.json());
}

const ref = (entityType: string, stableId: string) => ({ sourceId: 'demo', entityType, stableId });
const AGGREGATE = { type: 'SEEN_WITH', from: ref('widget', 'W-1'), to: ref('gadget', 'GT-1') };

describe('evidence on a relationship row with no stable ID', () => {
  it('is searched like a row with one: the row is not named as not searched and its property is read through its index', async () => {
    const { app, executor } = await started([seen(1)]);
    const answer = await answerOf(app);
    expect(answer.evidence.searchable).toBe(true);
    expect(answer.evidence.disabledRelationshipTypes).toEqual([]);
    expect(evidenceCalls(executor)[0]?.cypher).toContain('USING RANGE INDEX SEEK r:`SEEN_WITH`(`recordId`)');
    await app.close();
  });

  it('is one aggregate hit for its type and its two ends, with each member on the page, its element ID, evidence values and time, and an exact member count', async () => {
    const { app } = await started([seen(1, { seenAt: '2026-03-01T10:00:00Z', docId: 'DOC-7' }), seen(2)]);
    const answer = await answerOf(app);
    expect(answer.evidence.hits).toEqual([
      {
        aggregate: AGGREGATE,
        members: [
          { elementId: '5:n:001', records: [{ sourceRecordId: TEXT }, { sourceRecordId: 'DOC-7' }], observedAt: '2026-03-01T10:00:00Z' },
          { elementId: '5:n:002', records: [{ sourceRecordId: TEXT }] },
        ],
        memberCount: { value: 2, quality: 'exact', scope: 'members' },
        rules: [],
      },
    ]);
    expect(answer.evidence.count).toEqual({ value: 2, quality: 'exact', scope: 'search:evidence' });
    await app.close();
  });

  it('is one aggregate for each pair of ends, after the stored hits of the rows before it, and the count is the relationships held', async () => {
    const { app } = await started([seen(1), seen(2, {}, otherWidget), made('L-1', { recordId: TEXT })]);
    const answer = await answerOf(app);
    expect(storedHits(answer.evidence.hits).map((hit) => hit.supports.stableId)).toEqual(['L-1']);
    expect(aggregateHits(answer.evidence.hits).map((hit) => hit.aggregate)).toEqual([AGGREGATE, { ...AGGREGATE, from: ref('widget', 'W-2') }]);
    expect(answer.evidence.hits.map((hit) => ('supports' in hit ? 'stored' : 'aggregate'))).toEqual(['stored', 'aggregate', 'aggregate']);
    expect(answer.evidence.count).toEqual({ value: 3, quality: 'exact', scope: 'search:evidence' });
    expect(answer.facets?.searchable === true ? answer.facets.matchMode.find((entry) => entry.mode === 'evidence')?.count : undefined).toEqual({ value: 3, quality: 'exact', scope: 'search:facet:matchMode' });
    await app.close();
  });

  it('holds a member count that is a lower bound, and a cursor, when the read found more than the page', async () => {
    const { app } = await started(Array.from({ length: 30 }, (_, index) => seen(index + 1)));
    const answer = await answerOf(app);
    const [hit] = aggregateHits(answer.evidence.hits);
    expect(hit?.members).toHaveLength(25);
    expect(hit?.memberCount).toEqual({ value: 25, quality: 'lowerBound', scope: 'members' });
    expect(answer.evidence.count).toEqual({ value: 25, quality: 'lowerBound', scope: 'search:evidence' });
    expect(answer.evidence.nextCursor).toBeDefined();
    await app.close();
  });

  it('gives the next members of the same aggregate on the next page, none twice, with a lower-bound member count, and the group count is the members of both pages', async () => {
    const { app } = await started(Array.from({ length: 30 }, (_, index) => seen(index + 1)));
    const answer = await answerOf(app);
    const page = await moreOf(app, answer.evidence.nextCursor ?? '');
    if (page.group !== 'evidence') throw new Error('not an evidence page');
    const [first] = aggregateHits(answer.evidence.hits);
    const [next] = aggregateHits(page.hits);
    expect(next?.aggregate).toEqual(first?.aggregate);
    expect(next?.members.map((member) => member.elementId)).toEqual(Array.from({ length: 5 }, (_, index) => `5:n:${String(index + 26).padStart(3, '0')}`));
    expect(next?.memberCount).toEqual({ value: 5, quality: 'lowerBound', scope: 'members' });
    expect(page.count).toEqual({ value: 30, quality: 'exact', scope: 'search:evidence' });
    expect(page.nextCursor).toBeUndefined();
    await app.close();
  });

  it('gives a member no reference, no stable ID and no cursor: only its element ID, as text, its records and its time', async () => {
    const { app } = await started([seen(1, { seenAt: '2026-03-01T10:00:00Z' })]);
    const answer = await answerOf(app);
    const [hit] = aggregateHits(answer.evidence.hits);
    for (const member of hit?.members ?? []) expect(Object.keys(member).sort()).toEqual(['elementId', 'observedAt', 'records']);
    expect(hit !== undefined && 'supports' in hit).toBe(false);
    await app.close();
  });
});

describe('evidence that cannot be read', () => {
  it('keeps a stored hit whose evidence value is neither text nor a number, with the record marked unreadable and its property, and counts it', async () => {
    const { app } = await started([made('L-1', { recordId: TEXT, docId: [1, 2] }), made('L-2', { recordId: TEXT, docId: true })]);
    const answer = await answerOf(app);
    expect(storedHits(answer.evidence.hits).map((hit) => [hit.supports.stableId, hit.records])).toEqual([
      ['L-1', [{ sourceRecordId: TEXT }, { property: 'docId', unreadable: true }]],
      ['L-2', [{ sourceRecordId: TEXT }, { property: 'docId', unreadable: true }]],
    ]);
    expect(answer.evidence.count).toEqual({ value: 2, quality: 'exact', scope: 'search:evidence' });
    await app.close();
  });

  it('keeps a hit whose only evidence value cannot be read, stored or a member, so the count and the list agree', async () => {
    const plain = (node: StoredNode) => ({ $type: 'node', elementId: node.elementId, labels: [node.label], properties: node.properties });
    const row = (relationship: StoredRelationship) => ({
      r: { $type: 'relationship', elementId: relationship.elementId, type: relationship.type, startElementId: relationship.from.elementId, endElementId: relationship.to.elementId, properties: relationship.properties },
      a: plain(relationship.from),
      b: plain(relationship.to),
    });
    const rows = [made('L-1', { recordId: TEXT }), made('L-2', { recordId: { $type: 'unsupported' } }), seen(1, { recordId: { $type: 'point', srid: 7203, x: 1, y: 2 } })].map(row);
    const model = searchModelOf([widgetNode, otherWidget, gadgetNode]);
    const { app } = await startSearchApp({ mapping, respond: (call) => (call.templateId === 'relationship-evidence' ? Promise.resolve({ status: 'rows', rows }) : model(call)) });
    const answer = await answerOf(app);
    expect(storedHits(answer.evidence.hits).map((hit) => [hit.supports.stableId, hit.records])).toEqual([
      ['L-1', [{ sourceRecordId: TEXT }]],
      ['L-2', [{ property: 'recordId', unreadable: true }]],
    ]);
    expect(aggregateHits(answer.evidence.hits)[0]?.members).toEqual([{ elementId: '5:n:001', records: [{ property: 'recordId', unreadable: true }] }]);
    expect(answer.evidence.count).toEqual({ value: 3, quality: 'exact', scope: 'search:evidence' });
    expect(relationshipsOf(answer.evidence.hits)).toBe(3);
    await app.close();
  });
});
