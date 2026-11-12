import type { Count, GraphEdge } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { ref } from '../state/test-data.js';
import { placeholderEdge } from '../draft/unmapped.js';
import { coverageEntitiesOf } from './coverage-input.js';
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

  it('leaves out derived and unknown-origin relationships and those of other nodes, and counts a self-relationship at both of its ends', () => {
    const other = ref('a', 'type-a', 'n2');
    const loaded = loadedOf(
      graphOf([plain('r1', 'b1', 'kind-b', { semantics: 'derived' }), plain('r2', 'b2', 'kind-b', { semantics: 'unknown' }), plain('r3', 'b3', 'kind-b', { from: other }), plain('r4', 'n1', 'type-a', { to: node })]),
      node,
    );
    expect(loaded.byType.has('kind-b')).toBe(false);
    expect(loaded.byType.get('type-a')).toMatchObject({ value: 2, quality: 'exact' });
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
    expect(scopeLineText(exact(22), { value: 4, quality: 'lowerBound', scope: 'x' })).toBe('≥ 4 of 22 sourced neighbors on canvas · not loaded: no count while the loaded count is a lower bound');
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

describe('the relationship ends loaded at a node', () => {
  const selfLoop = (id: string): GraphEdge => ({ ...plain(id, 'n1', 'type-a'), to: node, ref: { sourceId: 'a', type: 'link-a', from: 'type-a', to: 'type-a', stableId: id } });

  it('counts a relationship from the node to itself at both of its ends, as the degree total does, in the total, by neighbor type and by relationship type', () => {
    const edges = [plain('r1', 'b1'), plain('r2', 'b2'), selfLoop('r3')];
    const loaded = loadedOf(graphOf(edges), node);
    expect(loaded.total).toEqual({ value: 4, quality: 'exact', scope: 'loaded in this view' });
    expect(loaded.byType.get('type-a')?.value).toBe(2);
    expect(loadedByRelationshipType(graphOf(edges), node).get('link-a')?.value).toBe(4);
  });

  it('says 14 not loaded, and not 15, for an exact total of 47 with 31 neighbors and one self-relationship loaded', () => {
    const edges = [...Array.from({ length: 31 }, (_unused, at) => plain(`r${at}`, `b${at}`)), selfLoop('self')];
    const loaded = loadedOf(graphOf(edges), node).total;
    expect(loaded.value).toBe(33);
    expect(scopeLineText({ value: 47, quality: 'exact', scope: 'x' }, loaded)).toBe('33 of 47 sourced neighbors on canvas · 14 not loaded');
  });

  it('agrees with the loaded count the coverage request sends for the node, in value and quality, for every kind of relationship', () => {
    const lowerBoundAggregate = aggregate('b5', count(7, 'lowerBound'));
    const { memberCount: _dropped, ...withoutCount } = aggregate('b6', count(1, 'exact'));
    const noCountAggregate: GraphEdge = withoutCount;
    const selfAggregate: GraphEdge = { ...aggregate('b4', count(2, 'exact')), to: node, ref: { sourceId: 'a', aggregate: { type: 'link-a', from: node, to: node } } };
    const cases: readonly [string, GraphEdge[]][] = [
      ['plain relationships and a self-relationship', [plain('r1', 'b1'), plain('r2', 'b2'), selfLoop('r3')]],
      ['an exact aggregate', [plain('r1', 'b1'), aggregate('b3', count(5, 'exact'))]],
      ['an estimated aggregate', [plain('r1', 'b1'), aggregate('b3', count(5, 'estimated'))]],
      ['a self-aggregate', [plain('r1', 'b1'), selfAggregate]],
      ['a lower-bound aggregate', [plain('r1', 'b1'), lowerBoundAggregate]],
      ['an aggregate with no member count', [plain('r1', 'b1'), noCountAggregate]],
      ['a derived relationship, which neither counts', [plain('r1', 'b1'), plain('r2', 'b2', 'kind-b', { semantics: 'derived' })]],
      ['a relationship of unknown origin, which neither counts', [plain('r1', 'b1'), plain('r2', 'b2', 'kind-b', { semantics: 'unknown' })]],
      ['a draft relationship that is no longer mapped, which neither counts', [plain('r1', 'b1'), placeholderEdge('a', { t: 'link-a', from: { t: 'type-a', id: 'n1' }, to: { t: 'kind-b', id: 'b7' }, id: 'gone' })]],
    ];
    for (const [name, edges] of cases) {
      const nodes = [node, ...['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'].map((id) => ref('a', 'kind-b', id))].map((entityRef) => ({ ref: entityRef, display: { title: 't', type: entityRef.entityType }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } }));
      const graph: LoadedGraph = { ...graphOf(edges), nodes };
      const sent = coverageEntitiesOf(graph).find((entity) => entity.ref.stableId === node.stableId);
      const shown = loadedOf(graph, node).total;
      const quality = shown.quality === 'lowerBound' ? 'unknown' : shown.quality;
      expect(sent?.loadedQuality, name).toBe(quality);
      if (quality !== 'unknown') expect(sent?.loadedRelationships, name).toBe(shown.value);
    }
  });
});

describe('the sentence when the loaded count is a lower bound', () => {
  const exact = (value: number): Count => ({ value, quality: 'exact', scope: 'x' });
  const floor = (value: number): Count => ({ value, quality: 'lowerBound', scope: 'x' });
  const reason = 'not loaded: no count while the loaded count is a lower bound';

  it('names why there is no remainder, whatever the total, instead of saying only that there is no count', () => {
    expect(scopeLineText(exact(25), floor(24))).toBe(`≥ 24 of 25 sourced neighbors on canvas · ${reason}`);
    expect(scopeLineText(exact(25), floor(26))).toBe(`≥ 26 of 25 sourced neighbors on canvas · ${reason}`);
    expect(scopeLineText({ value: 25, quality: 'lowerBound', scope: 'x' }, floor(24))).toBe(`≥ 24 of ≥ 25 sourced neighbors on canvas · ${reason}`);
    expect(scopeLineText({ value: 25, quality: 'estimated', scope: 'x' }, floor(24))).toBe(`≥ 24 of ~ 25 sourced neighbors on canvas · ${reason}`);
  });

  it('keeps "no count" without the reason when the loaded count is estimated or has no value, and leaves the remainder text of the node card as it was', () => {
    expect(scopeLineText(exact(22), { value: 4, quality: 'estimated', scope: 'x' })).toBe('~ 4 of 22 sourced neighbors on canvas · not loaded: no count');
    expect(scopeLineText(exact(25), { quality: 'unknown', scope: 'x' })).toBe('not loaded: no count');
    expect(notLoadedText(notLoadedOf(exact(25), floor(24)))).toBe('not loaded: no count');
  });

  it('is a lower bound when an aggregate has no member count or a lower-bound one, while the rows of the plain relationship types stay exact', () => {
    const edges = [plain('r1', 'b1'), aggregate('c1', { quality: 'lowerBound', value: 3, scope: 'x' }, { type: 'link-c' })];
    const loaded = loadedOf(graphOf(edges), node);
    expect(loaded.total.quality).toBe('lowerBound');
    expect(loaded.byType.get('kind-b')?.quality).toBe('lowerBound');
    expect(loadedByRelationshipType(graphOf(edges), node).get('link-a')).toMatchObject({ value: 1, quality: 'exact' });
  });
});
