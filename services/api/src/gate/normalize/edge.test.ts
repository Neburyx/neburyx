import { describe, expect, it } from 'vitest';
import { edgeSchema } from '@neburyx/contracts';
import { PACKS, packSource, readFixture } from '../../testing/pack-fixtures.js';
import { context, pairedSource, plainNode, plainRelationship } from '../../testing/normalize-fixtures.js';
import { normalizeModelOf } from './model.js';
import { normalizeRows, normalizeWithEvidence } from './index.js';
import { mappingOf, sourceWith } from '../../testing/gate-fixtures.js';

const gadget = (id: string) => plainNode(['Gadget'], { gadgetId: id, title: id, kind: 'k', madeOn: '2026' });
const person = (id: string) => plainNode(['Person'], { personId: id });
const row = (...values: unknown[]) => ({ values });
const ref = (entityType: string, stableId: string) => ({ sourceId: 'request-source', entityType, stableId });

describe('a relationship of a type mapped with a stable ID', () => {
  it('is a stored edge of its own with its ends, its projected properties, its evidence and its time', () => {
    const a = person('p1');
    const b = person('p2');
    const knows = plainRelationship('KNOWS', a, b, { linkId: 'L-1', seenAt: { $type: 'dateTime', value: '2026-01-02T03:04:05+02:00' }, recordId: 'REC-1', stray: 'SECRET' });
    const result = normalizeRows(context(), [row(a, knows, b)]);
    expect(result.edges).toHaveLength(1);
    const [edge] = result.edges;
    expect(edgeSchema.safeParse(edge).success).toBe(true);
    expect(edge).toMatchObject({
      ref: { sourceId: 'request-source', type: 'KNOWS', from: 'person', to: 'person', stableId: 'L-1' },
      from: ref('person', 'p1'),
      to: ref('person', 'p2'),
      type: 'KNOWS',
      direction: 'from-to',
      semantics: 'stored',
      evidenceRefs: ['REC-1'],
      observedAt: '2026-01-02T03:04:05+02:00',
    });
    expect(edge && 'memberCount' in edge).toBe(false);
    expect((edge?.properties ?? []).map((property) => property.key)).toEqual(['linkId', 'seenAt', 'recordId']);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('is one edge when the same relationship comes twice, in the place of its first appearance, with no flag', () => {
    const [a, b, c] = [person('p1'), person('p2'), person('p3')] as const;
    const first = plainRelationship('KNOWS', a, b, { linkId: 'L-1' });
    const other = plainRelationship('KNOWS', b, c, { linkId: 'L-2' });
    const result = normalizeRows(context(), [row(a, first, b), row(b, other, c), row(a, { ...first }, b)]);
    expect(result.edges.map((edge) => 'stableId' in edge.ref && edge.ref.stableId)).toEqual(['L-1', 'L-2']);
    expect(result.edges.every((edge) => edge.qualityFlags.length === 0)).toBe(true);
  });

  it('keeps the first edge and flags it conflicting-duplicate when a different relationship has the same stable ID, never hiding it', () => {
    const [a, b, c] = [person('p1'), person('p2'), person('p3')] as const;
    const first = plainRelationship('KNOWS', a, b, { linkId: 'L-1' });
    const twin = plainRelationship('KNOWS', b, c, { linkId: 'L-1' });
    const thrice = plainRelationship('KNOWS', a, c, { linkId: 'L-1' });
    const result = normalizeRows(context(), [row(a, first, b), row(b, twin, c), row(a, thrice, c)]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ from: ref('person', 'p1'), to: ref('person', 'p2'), qualityFlags: ['conflicting-duplicate'] });
  });

  it('is two edges, with no flag, when two relationship types have the same stable ID, each reference naming its type', () => {
    const [a, b] = [person('p1'), person('p2')] as const;
    const result = normalizeRows(context(), [row(a, plainRelationship('KNOWS', a, b, { linkId: 'L-9' }), b), row(a, plainRelationship('LIKES', a, b, { linkId: 'L-9' }), b)]);
    expect(result.edges.map((edge) => ('stableId' in edge.ref ? [edge.ref.type, edge.ref.stableId] : []))).toEqual([['KNOWS', 'L-9'], ['LIKES', 'L-9']]);
    expect(result.edges.every((edge) => edge.qualityFlags.length === 0)).toBe(true);
  });

  it('is two edges, with no flag, when one type between two pairs of entity types has the same stable ID, each reference naming its ends', () => {
    const a = person('p1');
    const [b, c] = [person('p2'), plainNode(['Org'], { orgId: 'o1' })] as const;
    const result = normalizeRows(context({ model: normalizeModelOf(pairedSource) }), [row(a, plainRelationship('KNOWS', a, b, { linkId: 'L-9' }), b), row(a, plainRelationship('KNOWS', a, c, { linkId: 'L-9' }), c)]);
    expect(result.edges.map((edge) => ('stableId' in edge.ref ? [edge.ref.from, edge.ref.to] : []))).toEqual([['person', 'person'], ['person', 'org']]);
    expect(result.edges.every((edge) => edge.qualityFlags.length === 0)).toBe(true);
  });

  it.each([{ label: 'absent', properties: {} }, { label: 'empty', properties: { linkId: '' } }, { label: 'a float', properties: { linkId: 1.5 } }])('is kept as a member of the aggregate, flagged, when its stable ID is $label', ({ properties }) => {
    const a = person('p1');
    const b = person('p2');
    const result = normalizeRows(context(), [row(a, plainRelationship('KNOWS', a, b, properties), b)]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ memberCount: { value: 1, quality: 'exact' }, qualityFlags: ['no-stable-id'] });
    expect(result.edges[0]?.ref).toHaveProperty('aggregate');
    expect(result.warnings).toEqual([]);
  });
});

describe('relationships of a type mapped without a stable ID', () => {
  it('are one aggregate edge for the type and the pair, however many there are, with an exact count of its members', () => {
    const a = gadget('g1');
    const b = person('p1');
    const members = [plainRelationship('MADE_BY', a, b), plainRelationship('MADE_BY', a, b), plainRelationship('MADE_BY', a, b)];
    const result = normalizeRows(context(), members.map((member) => row(a, member, b)));
    expect(result.edges).toHaveLength(1);
    const [edge] = result.edges;
    expect(edgeSchema.safeParse(edge).success).toBe(true);
    expect(edge).toMatchObject({
      ref: { sourceId: 'request-source', aggregate: { type: 'MADE_BY', from: ref('gadget', 'g1'), to: ref('person', 'p1') } },
      memberCount: { value: 3, quality: 'exact', scope: 'members' },
      type: 'MADE_BY',
      direction: 'from-to',
      semantics: 'stored',
    });
  });

  it('are an aggregate also when there is one, and no member is an edge of its own', () => {
    const a = gadget('g1');
    const b = person('p1');
    const result = normalizeRows(context(), [row(a, plainRelationship('MADE_BY', a, b), b)]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.memberCount).toEqual({ value: 1, quality: 'exact', scope: 'members' });
  });

  it('count a member once when the same relationship comes in two rows', () => {
    const a = gadget('g1');
    const b = person('p1');
    const member = plainRelationship('MADE_BY', a, b);
    const result = normalizeRows(context(), [row(a, member, b), row(a, { ...member }, b), row(a, plainRelationship('MADE_BY', a, b), b)]);
    expect(result.edges[0]?.memberCount?.value).toBe(2);
  });

  it('have a lower-bound count when the page was cut, and an exact one when it was not', () => {
    const a = gadget('g1');
    const b = person('p1');
    const rows = [row(a, plainRelationship('MADE_BY', a, b), b), row(a, plainRelationship('MADE_BY', a, b), b)];
    expect(normalizeRows(context({ hasMore: true }), rows).edges[0]?.memberCount).toEqual({ value: 2, quality: 'lowerBound', scope: 'members' });
    expect(normalizeRows(context({ hasMore: false }), rows).edges[0]?.memberCount).toEqual({ value: 2, quality: 'exact', scope: 'members' });
  });

  it('are one aggregate for each pair and each type, in the order of their first member', () => {
    const [g1, g2] = [gadget('g1'), gadget('g2')] as const;
    const [p1, p2] = [person('p1'), person('p2')] as const;
    const result = normalizeRows(context(), [row(g1, plainRelationship('MADE_BY', g1, p1), p1), row(g2, plainRelationship('MADE_BY', g2, p1), p1), row(g1, plainRelationship('MADE_BY', g1, p2), p2), row(g1, plainRelationship('MADE_BY', g1, p1), p1)]);
    expect(result.edges.map((edge) => [edge.from.stableId, edge.to.stableId, edge.memberCount?.value])).toEqual([['g1', 'p1', 2], ['g2', 'p1', 1], ['g1', 'p2', 1]]);
  });

  it('take the first and last observed time of their members from the mapped property, as the members gave it', () => {
    const a = gadget('g1');
    const b = person('p1');
    const made = (value: unknown) => row(a, plainRelationship('MADE_BY', a, b, { madeAt: value }), b);
    const result = normalizeRows(context(), [made({ $type: 'dateTime', value: '2026-01-02T10:00:00+02:00' }), made({ $type: 'dateTime', value: '2026-01-02T09:30:00Z' }), made('not a time'), made(undefined)]);
    expect(result.edges[0]).toMatchObject({ observedFirst: '2026-01-02T10:00:00+02:00', observedLast: '2026-01-02T09:30:00Z', qualityFlags: [] });
    expect(result.edges[0]?.memberCount?.value).toBe(4);
  });

  it('use the zoned members and carry the flag mixed-time-kinds when zoned and local times are mixed', () => {
    const a = gadget('g1');
    const b = person('p1');
    const made = (value: unknown) => row(a, plainRelationship('MADE_BY', a, b, { madeAt: value }), b);
    const result = normalizeRows(context(), [made({ $type: 'localDateTime', value: '2020-01-01T00:00:00' }), made({ $type: 'dateTime', value: '2026-01-02T03:04:05Z' })]);
    expect(result.edges[0]).toMatchObject({ observedFirst: '2026-01-02T03:04:05Z', observedLast: '2026-01-02T03:04:05Z', qualityFlags: ['mixed-time-kinds'] });
  });

  it('have no first and last when no member has a time it can read', () => {
    const a = gadget('g1');
    const b = person('p1');
    const result = normalizeRows(context(), [row(a, plainRelationship('MADE_BY', a, b), b)]);
    expect(result.edges[0] && 'observedFirst' in result.edges[0]).toBe(false);
    expect(result.edges[0] && 'observedLast' in result.edges[0]).toBe(false);
  });
});

describe('a relationship that is left out', () => {
  it('is dropped and counted when one of its ends was left out', () => {
    const a = gadget('g1');
    const stranger = plainNode(['Stranger'], { id: 'x' });
    const result = normalizeRows(context(), [row(a, plainRelationship('MADE_BY', a, stranger), stranger)]);
    expect(result.edges).toEqual([]);
    expect(result.dropped['not-mapped']).toBe(1);
    expect(result.dropped['end-not-shown']).toBe(1);
  });

  it('is dropped when an end is not in the rows', () => {
    const a = gadget('g1');
    const b = person('p1');
    const result = normalizeRows(context(), [row(a, plainRelationship('MADE_BY', a, b))]);
    expect(result.edges).toEqual([]);
    expect(result.dropped['end-missing']).toBe(1);
  });

  it('is dropped when its type is not mapped between the entity types of its ends', () => {
    const a = gadget('g1');
    const b = person('p1');
    const result = normalizeRows(context(), [row(a, plainRelationship('KNOWS', a, b, { linkId: 'L' }), b), row(a, plainRelationship('UNMAPPED', a, b), b)]);
    expect(result.edges).toEqual([]);
    expect(result.dropped['no-mapping-row']).toBe(2);
  });

  it('is dropped, never turned round, when it runs against the mapped direction', () => {
    const a = gadget('g1');
    const b = person('p1');
    const result = normalizeRows(context(), [row(b, plainRelationship('MADE_BY', b, a), a)]);
    expect(result.edges).toEqual([]);
    expect(result.dropped['no-mapping-row']).toBe(1);
  });

  it('leaves the aggregate of the remaining members built from them only', () => {
    const a = gadget('g1');
    const b = person('p1');
    const stranger = plainNode(['Stranger'], { id: 'x' });
    const result = normalizeRows(context(), [row(a, plainRelationship('MADE_BY', a, b), b), row(a, plainRelationship('MADE_BY', a, stranger), stranger), row(a, plainRelationship('MADE_BY', a, b), b)]);
    expect(result.edges[0]?.memberCount?.value).toBe(2);
  });
});

describe.each(PACKS)('relationships captured from the %s pack', (pack) => {
  const source = packSource(pack);
  const model = { sourceId: 'request-source', hasMore: false, model: normalizeModelOf(source) };

  it('give the first mapped relationship as an aggregate with one member, or a stored edge when it has a stable ID', () => {
    const rows = readFixture(pack)['relationship'] as Record<string, unknown>[];
    const mapped = source.relationships[0];
    const result = normalizeRows(model, rows);
    expect(result.dropped).toEqual({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });
    expect(result.edges).toHaveLength(1);
    expect(edgeSchema.safeParse(result.edges[0]).success).toBe(true);
    expect(result.edges[0]?.type).toBe(mapped?.type);
    if (mapped?.stableId === undefined) expect(result.edges[0]?.memberCount).toEqual({ value: 1, quality: 'exact', scope: 'members' });
  });

  it('give the first relationship with a stable ID as a stored edge with that ID, its time and its evidence', () => {
    const rows = readFixture(pack)['stored'] as Record<string, unknown>[];
    const mapped = source.relationships.find((relationship) => relationship.stableId !== undefined);
    const raw = (rows[0] as { r: { properties: Record<string, unknown> } }).r.properties;
    const result = normalizeRows(model, rows);
    const [edge] = result.edges;
    expect(result.edges).toHaveLength(1);
    expect(edge?.semantics).toBe('stored');
    expect(edge && 'stableId' in edge.ref && edge.ref.stableId).toBe(String(raw[mapped?.stableId ?? '']));
    expect(edge?.observedAt).toBe((raw[mapped?.observedAt ?? ''] as { value: string }).value);
    expect(edge?.evidenceRefs).toEqual((mapped?.evidence ?? []).map((key) => String(raw[key])));
  });

  it('give the two relationships made between one pair as one aggregate of two members, counted once however often they come', () => {
    const rows = readFixture(pack)['members'] as Record<string, unknown>[];
    const result = normalizeRows(model, [...rows, ...rows]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.memberCount).toEqual({ value: 2, quality: 'exact', scope: 'members' });
    expect(normalizeRows({ ...model, hasMore: true }, rows).edges[0]?.memberCount).toEqual({ value: 2, quality: 'lowerBound', scope: 'members' });
  });
});

describe('the evidence of each relationship, for the evidence search', () => {
  const evidenceSource =
    mappingOf(
      sourceWith('alpha', {
        entities: [
          { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
          { type: 'person', label: 'Person', stable_id: 'personId' },
        ],
        relationships: [
          { type: 'MADE_BY', from: 'gadget', to: 'person', observed_at: 'madeAt', evidence: ['recordId', 'docId'] },
          { type: 'KNOWS', from: 'person', to: 'person', stable_id: 'linkId', evidence: ['recordId', 'docId'] },
        ],
      }),
    ).sources[0] ?? failNoSource();
  const evidenceContext = context({ model: normalizeModelOf(evidenceSource) });
  const a = gadget('g1');
  const b = person('p1');

  it('gives each member of an aggregate its element ID, its records and its time, in the order read, and leaves the aggregate edge as normalizeRows gives it', () => {
    const rows = [row(a, plainRelationship('MADE_BY', a, b, { recordId: 'R-1', madeAt: '2026-01-02' }, 'm1'), b), row(a, plainRelationship('MADE_BY', a, b, { recordId: 'R-1', docId: 7 }, 'm2'), b)];
    const result = normalizeWithEvidence(evidenceContext, rows);
    const aggregate = { type: 'MADE_BY', from: ref('gadget', 'g1'), to: ref('person', 'p1') };
    expect(result.evidence).toEqual([
      { elementId: 'm1', of: { aggregate }, records: [{ sourceRecordId: 'R-1' }], observedAt: '2026-01-02' },
      { elementId: 'm2', of: { aggregate }, records: [{ sourceRecordId: 'R-1' }, { sourceRecordId: '7' }] },
    ]);
    const plain = normalizeRows(evidenceContext, rows);
    expect(result.edges).toEqual(plain.edges);
    expect(plain.edges[0]?.evidenceRefs).toEqual([]);
    expect('evidence' in plain).toBe(false);
  });

  it('gives a stored relationship its reference and records, once for the same relationship twice', () => {
    const [p1, p2] = [person('p1'), person('p2')] as const;
    const knows = plainRelationship('KNOWS', p1, p2, { linkId: 'L-1', recordId: 'R-1', docId: 'R-1' }, 's1');
    const result = normalizeWithEvidence(evidenceContext, [row(p1, knows, p2), row(p1, { ...knows }, p2)]);
    expect(result.evidence).toEqual([{ elementId: 's1', of: { stored: { sourceId: 'request-source', type: 'KNOWS', from: 'person', to: 'person', stableId: 'L-1' } }, records: [{ sourceRecordId: 'R-1' }], carriers: { 'R-1': ['recordId', 'docId'] } }]);
  });

  it.each([
    ['a list', ['R-1', 'R-2']],
    ['a boolean', true],
    ['a point', { $type: 'point', srid: 7203, x: 1, y: 2 }],
    ['a map', { nested: 'R-1' }],
    ['a value the adapter could not convert', { $type: 'unsupported' }],
  ])('keeps %s as an unreadable record with its property, and leaves the stored evidence refs as they were', (_name, value) => {
    const [p1, p2] = [person('p1'), person('p2')] as const;
    const knows = plainRelationship('KNOWS', p1, p2, { linkId: 'L-1', recordId: 'R-1', docId: value }, 's1');
    const result = normalizeWithEvidence(evidenceContext, [row(p1, knows, p2)]);
    expect(result.evidence[0]?.records).toEqual([{ sourceRecordId: 'R-1' }, { property: 'docId', unreadable: true }]);
    expect(result.edges[0]?.evidenceRefs).toEqual(['R-1']);
    const member = normalizeWithEvidence(evidenceContext, [row(a, plainRelationship('MADE_BY', a, b, { recordId: value }, 'm1'), b)]);
    expect(member.evidence[0]?.records).toEqual([{ property: 'recordId', unreadable: true }]);
  });

  it('lists nothing for an evidence property that is absent, null or empty text', () => {
    const result = normalizeWithEvidence(evidenceContext, [row(a, plainRelationship('MADE_BY', a, b, { recordId: '', docId: null }, 'm1'), b)]);
    expect(result.evidence[0]?.records).toEqual([]);
  });

  it('gives no evidence for a relationship that is left out', () => {
    const result = normalizeWithEvidence(evidenceContext, [row(a, plainRelationship('MADE_BY', a, plainNode(['Stranger'], { id: 'x' }), { recordId: 'R-1' }))]);
    expect(result.evidence).toEqual([]);
    expect(result.dropped['end-missing']).toBe(1);
  });
});

function failNoSource(): never {
  throw new Error('the mapping has no source');
}
