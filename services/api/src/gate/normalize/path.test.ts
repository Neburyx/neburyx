import { describe, expect, it } from 'vitest';
import { PACKS, packSource, readFixture } from '../../testing/pack-fixtures.js';
import { context, plainNode, plainRelationship } from '../../testing/normalize-fixtures.js';
import { normalizeModelOf } from './model.js';
import { normalizeRows } from './index.js';

const pathOf = (start: ReturnType<typeof plainNode>, ...hops: [ReturnType<typeof plainRelationship>, ReturnType<typeof plainNode>][]) => ({
  $type: 'path' as const,
  start,
  segments: hops.map(([relationship, end]) => ({ relationship, end })),
});

describe('a path', () => {
  const g = plainNode(['Gadget'], { gadgetId: 'g1', title: 'a', kind: 'k', madeOn: '1' });
  const p = plainNode(['Person'], { personId: 'p1' });
  const q = plainNode(['Person'], { personId: 'p2' });

  it('gives its nodes and its relationships once each, in the order of the path', () => {
    const made = plainRelationship('MADE_BY', g, p);
    const knows = plainRelationship('KNOWS', p, q, { linkId: 'L-1' });
    const result = normalizeRows(context(), [{ p: pathOf(g, [made, p], [knows, q]) }]);
    expect(result.nodes.map((node) => node.ref.stableId)).toEqual(['g1', 'p1', 'p2']);
    expect(result.edges.map((edge) => edge.type)).toEqual(['MADE_BY', 'KNOWS']);
  });

  it('counts a node or relationship that is also in another column or another row once', () => {
    const made = plainRelationship('MADE_BY', g, p);
    const knows = plainRelationship('KNOWS', p, q, { linkId: 'L-1' });
    const result = normalizeRows(context(), [{ a: g, r: made, b: p, p: pathOf(g, [made, p], [knows, q]) }, { p: pathOf(g, [made, p]) }]);
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(2);
    expect(result.edges[0]?.memberCount?.value).toBe(1);
  });

  it('keeps the hops that remain when one is left out, and joins nothing across the gap', () => {
    const stranger = plainNode(['Stranger'], { id: 'x' });
    const toStranger = plainRelationship('KNOWS', p, stranger, { linkId: 'L-2' });
    const fromStranger = plainRelationship('KNOWS', stranger, q, { linkId: 'L-3' });
    const made = plainRelationship('MADE_BY', g, p);
    const knows = plainRelationship('KNOWS', q, q, { linkId: 'L-4' });
    const result = normalizeRows(context(), [{ p: pathOf(g, [made, p], [toStranger, stranger], [fromStranger, q], [knows, q]) }]);
    expect(result.nodes.map((node) => node.ref.stableId)).toEqual(['g1', 'p1', 'p2']);
    expect(result.edges.map((edge) => edge.type + ':' + edge.from.stableId + '>' + edge.to.stableId)).toEqual(['MADE_BY:g1>p1', 'KNOWS:p2>p2']);
    expect(result.dropped['not-mapped']).toBe(1);
    expect(result.dropped['end-not-shown']).toBe(2);
  });
});

describe.each(PACKS)('a path of two hops captured from the %s pack', (pack) => {
  it('gives three nodes and two edges in path order', () => {
    const source = packSource(pack);
    const rows = readFixture(pack)['path'] as Record<string, unknown>[];
    const result = normalizeRows({ sourceId: 'x', hasMore: false, model: normalizeModelOf(source) }, rows);
    const path = (rows[0] as { p: { start: { properties: Record<string, unknown> }; segments: { relationship: { type: string } }[] } }).p;
    expect(result.dropped).toEqual({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(2);
    expect(result.edges.map((edge) => ('aggregate' in edge.ref ? edge.ref.aggregate.type : edge.type))).toEqual(path.segments.map((segment) => segment.relationship.type));
  });
});
