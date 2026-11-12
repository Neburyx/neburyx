import type { Count, GraphEdge } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { edge, ref } from '../state/test-data.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { loadedOf } from '../workspace/node-counts.js';
import { coverageEntitiesOf } from '../workspace/coverage-input.js';
import { relationshipLook } from './relationship-look.js';
import { drawnMemberCount, withReadMemberCounts } from './read-member-counts.js';

const from = ref('a', 'type-a', 'n1');
const to = ref('a', 'type-a', 'n2');
const count = (value: number | undefined, quality: Count['quality']): Count => (value === undefined ? { quality, scope: 'x' } : { value, quality, scope: 'x' });
const aggregate = (memberCount: Count | undefined, id = 'SENT'): GraphEdge => ({
  ...edge('a', 'e1', 'n1', 'n2'),
  type: id,
  ref: { sourceId: 'a', aggregate: { type: id, from, to } },
  ...(memberCount === undefined ? {} : { memberCount }),
});
const graphOf = (edges: readonly GraphEdge[]): LoadedGraph => ({ nodes: [], edges, entities: count(0, 'exact'), relationships: count(edges.length, 'exact') });

describe('the member count an aggregate is drawn with after its evidence was read', () => {
  it('draws a lower bound as exact when the read found exactly that many members', () => {
    expect(drawnMemberCount(aggregate(count(3, 'lowerBound')), count(3, 'exact'))).toEqual(count(3, 'exact'));
  });

  it('keeps a lower bound that the read found more members than, since the panel counts every member whatever the view\'s filters', () => {
    const held = aggregate(count(3, 'lowerBound'));
    expect(drawnMemberCount(held, count(9, 'exact'))).toBe(held.memberCount);
  });

  it('draws no number when the read found fewer members than the lower bound, so no screen states both', () => {
    expect(drawnMemberCount(aggregate(count(3, 'lowerBound')), count(2, 'exact'))).toEqual({ quality: 'unknown', scope: 'members read for the evidence panel' });
  });

  it.each([
    ['no read yet', undefined],
    ['a read with no value', count(undefined, 'unknown')],
    ['a read that is not exact', count(5, 'lowerBound')],
  ])('keeps the count of the expand answer for %s', (_name, read) => {
    const held = aggregate(count(3, 'lowerBound'));
    expect(drawnMemberCount(held, read)).toBe(held.memberCount);
  });

  it('leaves an exact count, an estimated one and a relationship that is not an aggregate as they are', () => {
    const exact = aggregate(count(3, 'exact'));
    const estimated = aggregate(count(3, 'estimated'));
    expect(drawnMemberCount(exact, count(3, 'exact'))).toBe(exact.memberCount);
    expect(drawnMemberCount(estimated, count(3, 'exact'))).toBe(estimated.memberCount);
    const plain = edge('a', 'e2', 'n1', 'n2');
    expect(drawnMemberCount(plain, count(3, 'exact'))).toBe(plain.memberCount);
  });

  it('has the canvas leave out an exact 1 that the read confirmed, and keep it in the tip', () => {
    const [drawn] = withReadMemberCounts(graphOf([aggregate(count(1, 'lowerBound'))]), () => count(1, 'exact')).edges;
    expect(drawn).toBeDefined();
    const look = relationshipLook(drawn as GraphEdge);
    expect(look.label).toBe('SENT');
    expect(look.tip).toBe('SENT · 1 · exact');
    expect(look.single).toBe(true);
  });

  it('has the canvas show a confirmed count as exact in its label and badge', () => {
    const [drawn] = withReadMemberCounts(graphOf([aggregate(count(4, 'lowerBound'))]), () => count(4, 'exact')).edges;
    const look = relationshipLook(drawn as GraphEdge);
    expect(look.label).toBe('SENT · 4 · exact');
    expect(look.badge).toBe('4 · exact');
  });

  it('returns the same graph when no count changes', () => {
    const graph = graphOf([aggregate(count(3, 'exact'))]);
    expect(withReadMemberCounts(graph, () => count(3, 'exact'))).toBe(graph);
  });

  it('changes no loaded count: the inspector, the header and the export rows read the loaded graph, not the drawn one', () => {
    const graph: LoadedGraph = { ...graphOf([aggregate(count(3, 'lowerBound'))]), nodes: [] };
    const drawn = withReadMemberCounts(graph, () => count(3, 'exact'));
    expect(drawn).not.toBe(graph);
    expect(graph.edges[0]?.memberCount).toEqual(count(3, 'lowerBound'));
    expect(loadedOf(graph, from).total.quality).toBe('lowerBound');
    expect(coverageEntitiesOf(graph)).toEqual([]);
  });
});
