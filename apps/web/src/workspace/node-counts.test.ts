import type { Count, GraphEdge } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { ref } from '../state/test-data.js';
import { combineDegreeCounts, isSupernode, loadedByRelationshipType, loadedCountText, loadedOf, notLoadedOf, notLoadedText, scopeLineText } from './node-counts.js';
import { count, previewOf } from './supernode-kit.js';

const node = ref('a', 'type-a', 'n1');
const plain = (id: string, other: string, otherType = 'kind-b', over: Partial<GraphEdge> = {}): GraphEdge => ({
  ref: { sourceId: 'a', type: 'link-a', from: 'type-a', to: otherType, stableId: id },
  from: node,
  to: ref('a', otherType, other),
  type: 'link-a',
  direction: 'out',
  semantics: 'stored',
  properties: [],
  evidenceRefs: [],
  qualityFlags: [],
  ...over,
});
const aggregate = (other: string, members: Count, over: Partial<GraphEdge> = {}): GraphEdge => ({
  ...plain('x', other, 'kind-b', over),
  ref: { sourceId: 'a', aggregate: { type: 'link-a', from: node, to: ref('a', 'kind-b', other) } },
  memberCount: members,
});
const graphOf = (edges: GraphEdge[]): LoadedGraph => ({ nodes: [], edges, entities: count(0, 'exact'), relationships: count(edges.length, 'exact') });

describe('the loaded count of a node', () => {
  it('counts each stored relationship once, by the type at its other end, and an aggregate by its member count', () => {
    const loaded = loadedOf(graphOf([plain('r1', 'b1'), plain('r2', 'b2'), plain('r3', 'c1', 'kind-c'), aggregate('b3', count(5, 'exact'))]), node);
    expect(loaded.byType.get('kind-b')).toMatchObject({ value: 7, quality: 'exact' });
    expect(loaded.byType.get('kind-c')).toMatchObject({ value: 1, quality: 'exact' });
    expect(loaded.total).toMatchObject({ value: 8, quality: 'exact' });
  });

  it('leaves out derived and unknown-origin relationships and those of other nodes, and counts a self-relationship once', () => {
    const other = ref('a', 'type-a', 'n2');
    const loaded = loadedOf(
      graphOf([plain('r1', 'b1', 'kind-b', { semantics: 'derived' }), plain('r2', 'b2', 'kind-b', { semantics: 'unknown' }), plain('r3', 'b3', 'kind-b', { from: other }), plain('r4', 'n1', 'type-a', { to: node })]),
      node,
    );
    expect(loaded.byType.has('kind-b')).toBe(false);
    expect(loaded.byType.get('type-a')).toMatchObject({ value: 1, quality: 'exact' });
  });

  it.each([
    ['a lower-bound member count makes the sum a lower bound', [count(5, 'lowerBound')], 6, 'lowerBound'],
    ['an estimated member count makes it estimated', [count(5, 'estimated')], 6, 'estimated'],
    ['a mix of lower-bound and estimated counts is estimated', [count(5, 'lowerBound'), count(4, 'estimated')], 10, 'estimated'],
    ['a member count with no value counts one and makes it a lower bound', [count(undefined, 'unknown'), count(2, 'exact')], 4, 'lowerBound'],
  ] as const)('%s', (_, members, value, quality) => {
    const loaded = loadedOf(graphOf([plain('r1', 'b1'), ...members.map((member, at) => aggregate(`m${at}`, member))]), node);
    expect(loaded.total).toMatchObject({ value, quality });
  });
});

describe('what is not loaded', () => {
  const total = { exact: count(20, 'exact'), lowerBound: count(20, 'lowerBound'), estimated: count(20, 'estimated'), unknown: count(undefined, 'unknown') } as const;
  const loaded = { exact: count(8, 'exact'), lowerBound: count(8, 'lowerBound'), estimated: count(8, 'estimated') } as const;
  const same = { exact: count(20, 'exact'), lowerBound: count(20, 'lowerBound'), estimated: count(20, 'estimated') } as const;
  const above = { exact: count(21, 'exact'), lowerBound: count(21, 'lowerBound'), estimated: count(21, 'estimated') } as const;

  it.each([
    ['exact', 'exact', 12, 'exact'],
    ['lowerBound', 'exact', 12, 'lowerBound'],
    ['estimated', 'exact', 12, 'estimated'],
  ] as const)('an %s total and an %s loaded count give a remainder of %s with the quality of the total (%s)', (t, l, value, quality) => {
    expect(notLoadedOf(total[t], loaded[l])).toMatchObject({ value, quality });
  });

  it.each(
    (['exact', 'lowerBound', 'estimated', 'unknown'] as const).flatMap((t) => (['lowerBound', 'estimated'] as const).map((l) => [t, l] as const)),
  )('names no number for a %s total when the loaded count is a %s', (t, l) => {
    expect(notLoadedOf(total[t], loaded[l])).toBeUndefined();
  });

  it.each(['exact', 'lowerBound', 'estimated', 'unknown'] as const)('names no number for a %s total when the loaded count has no value to take away', (t) => {
    expect(notLoadedOf(total[t], { quality: 'unknown', scope: 'x' })).toBeUndefined();
  });

  it('names no number for an unknown total with an exact loaded count, nor with no total at all', () => {
    expect(notLoadedOf(total.unknown, loaded.exact)).toBeUndefined();
    expect(notLoadedOf(undefined, loaded.exact)).toBeUndefined();
  });

  it.each([
    ['exact', 'exact', 0, 'exact'],
    ['lowerBound', 'exact', undefined, undefined],
    ['estimated', 'exact', undefined, undefined],
  ] as const)('when what is loaded equals an %s total: a remainder of exactly zero only for an exact total', (t, l, value, quality) => {
    const found = notLoadedOf(total[t], same[l]);
    if (value === undefined) expect(found).toBeUndefined();
    else expect(found).toMatchObject({ value, quality });
  });

  it.each(['exact', 'lowerBound', 'estimated'] as const)('names no number, never a negative one, when more is loaded than a %s total says', (t) => {
    expect(notLoadedOf(total[t], above.exact)).toBeUndefined();
    expect(notLoadedOf(total[t], above.lowerBound)).toBeUndefined();
    expect(notLoadedOf(total[t], above.estimated)).toBeUndefined();
  });

  it('says it in the shared words, and loaded counts that are not exact with their quality', () => {
    expect(notLoadedText(notLoadedOf(count(3316, 'lowerBound'), count(35, 'exact')))).toBe('≥ 3,281 not loaded (lower bound)');
    expect(notLoadedText(notLoadedOf(count(40, 'estimated'), count(0, 'exact')))).toBe('~ 40 not loaded (estimated)');
    expect(notLoadedText(notLoadedOf(count(40, 'exact'), count(10, 'exact')))).toBe('30 not loaded');
    expect(notLoadedText(undefined)).toBe('not loaded: no count');
    expect(loadedCountText(count(35, 'exact'))).toBe('35 loaded');
    expect(loadedCountText(count(8, 'lowerBound'))).toBe('≥ 8 loaded');
    expect(loadedCountText(count(8, 'estimated'))).toBe('~ 8 loaded');
  });
});

describe('when the card says SUPERNODE', () => {
  it.each([
    ['every type fits one page of the default size', [{ entityType: 'k', count: count(25, 'exact') }], false],
    ['a type has an exact count above one page', [{ entityType: 'k', count: count(26, 'exact') }], true],
    ['a type has a lower-bound count', [{ entityType: 'k', count: count(3, 'lowerBound') }], true],
    ['a type has an unknown count', [{ entityType: 'k', count: count(undefined, 'unknown') }], true],
    ['an estimated count is above one page', [{ entityType: 'k', count: count(100, 'estimated') }], true],
    ['no type is named', [], false],
  ] as const)('when %s: %s', (_, byNeighborType, expected) => {
    expect(isSupernode(previewOf({ byNeighborType: [...byNeighborType], pageSize: 25 }))).toBe(expected);
  });

  it('is not said before there is a preview', () => {
    expect(isSupernode(undefined)).toBe(false);
  });
});

describe('the scope line of an entity\'s sourced neighbors', () => {
  const exact = (value: number): Count => ({ value, quality: 'exact', scope: 'x' });
  it('keeps the quality of the loaded and of the total, and draws no number when either has none', () => {
    expect(scopeLineText(exact(22), exact(4))).toBe('4 of 22 sourced neighbors on canvas · 18 not loaded');
    expect(scopeLineText(exact(22), { value: 4, quality: 'lowerBound', scope: 'x' })).toBe('≥ 4 of 22 sourced neighbors on canvas · not loaded: no count');
    expect(scopeLineText(exact(22), { value: 4, quality: 'estimated', scope: 'x' })).toBe('~ 4 of 22 sourced neighbors on canvas · not loaded: no count');
    expect(scopeLineText({ value: 30, quality: 'lowerBound', scope: 'x' }, exact(4))).toBe('4 of ≥ 30 sourced neighbors on canvas · ≥ 26 not loaded (lower bound)');
    expect(scopeLineText({ quality: 'unknown', scope: 'x' }, exact(4))).toBe('not loaded: no count');
    expect(scopeLineText(undefined, exact(4))).toBe('not loaded: no count');
  });
});

describe('the count of a relationship type over the directions of a degree preview', () => {
  const part = (value: number | undefined, quality: Count['quality']): Count => (value === undefined ? { quality: 'unknown', scope: 'x' } : { value, quality, scope: 'x' });
  it('adds the directions and keeps the weakest quality', () => {
    expect(combineDegreeCounts([part(2, 'exact'), part(1, 'exact')])).toMatchObject({ value: 3, quality: 'exact' });
    expect(combineDegreeCounts([part(2, 'exact'), part(1, 'lowerBound')])).toMatchObject({ value: 3, quality: 'lowerBound' });
    expect(combineDegreeCounts([part(2, 'lowerBound'), part(1, 'estimated')])).toMatchObject({ value: 3, quality: 'estimated' });
  });
  it('has no value when any direction has none, and is nothing for no direction', () => {
    expect(combineDegreeCounts([part(2, 'exact'), part(undefined, 'unknown')])?.value).toBeUndefined();
    expect(combineDegreeCounts([part(undefined, 'unknown')])?.quality).toBe('unknown');
    expect(combineDegreeCounts([])).toBeUndefined();
  });
});

describe('the loaded count by relationship type', () => {
  it('counts the stored relationships of the node by type, an aggregate by its members, and not a derived or unknown-origin one', () => {
    const derived = plain('3', 'n3', 'kind-b', { type: 'USES', semantics: 'derived', derivation: { ruleId: 'r', ruleVersion: 1, supportingEdgeRefs: [] } });
    const graph = graphOf([plain('1', 'n2', 'kind-b', { type: 'OWNS' }), plain('2', 'n3', 'kind-b', { type: 'OWNS' }), derived, plain('4', 'n4', 'kind-b', { type: 'LINKED', semantics: 'unknown' }), aggregate('n5', count(7, 'lowerBound'), { type: 'SENT' })]);
    const counted = loadedByRelationshipType(graph, node);
    expect([...counted.keys()].sort()).toEqual(['OWNS', 'SENT']);
    expect(counted.get('OWNS')).toMatchObject({ value: 2, quality: 'exact' });
    expect(counted.get('SENT')).toMatchObject({ value: 7, quality: 'lowerBound' });
  });
});
