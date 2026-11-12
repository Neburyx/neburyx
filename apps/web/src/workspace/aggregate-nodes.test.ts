import type { DegreePreview, GraphEdge } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { NodeExpansion, TypeProgress } from '../api/expand-store.js';
import { testProfile } from '../dev/test-profile.js';
import { elementKey } from '../state/keys.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { node, ref } from '../state/test-data.js';
import { aggregateKey, aggregateLinkKey, aggregateNodesOf, parseAggregateKey, type AggregateInput } from './aggregate-nodes.js';
import { count, previewOf } from './supernode-kit.js';

const anchor = ref('a', 'type-a', 'n1');
const anchorKey = elementKey(anchor);
const edgeTo = (id: string, type = 'kind-b'): GraphEdge => ({
  ref: { sourceId: 'a', type: 'link-a', from: 'type-a', to: type, stableId: id },
  from: anchor,
  to: ref('a', type, `b-${id}`),
  type: 'link-a',
  direction: 'out',
  semantics: 'stored',
  properties: [],
  evidenceRefs: [],
  qualityFlags: [],
});
const graph = (edges: GraphEdge[] = []): LoadedGraph => ({ nodes: [node('a', 'n1')], edges, entities: count(1, 'exact'), relationships: count(edges.length, 'exact') });
const idle = (types: [string, Partial<TypeProgress>][] = []): NodeExpansion => ({
  epoch: 'e',
  status: 'idle',
  failure: undefined,
  types: new Map(types.map(([type, progress]) => [type, { loaded: 0, hasMore: true, cursor: 'c', restartNeeded: false, ...progress }])),
  pageSize: undefined,
  chosenPageSize: undefined,
  duplicates: false,
  warnings: [],
  failedAction: undefined,
});

function input(overrides: Partial<AggregateInput> & { preview?: DegreePreview | undefined } = {}): AggregateInput {
  const { preview = previewOf({ byNeighborType: [{ entityType: 'kind-b', count: count(12, 'exact') }, { entityType: 'type-c', count: count(3300, 'lowerBound') }] }), ...rest } = overrides;
  return {
    graph: graph([edgeTo('r1'), edgeTo('r2')]),
    profile: testProfile('a', ['type-a']),
    touched: new Set([anchorKey]),
    previewOf: () => preview,
    expansionOf: () => idle(),
    relTypesOf: () => undefined,
    mapped: () => ['kind-b'],
    ...rest,
  };
}

describe('the aggregate nodes of the loaded graph', () => {
  it('draws one for each neighbor type with something not loaded, labelled loaded / total with the total\'s quality', () => {
    const drawn = aggregateNodesOf(input());
    expect(drawn.map((item) => item.label)).toEqual(['kind-b · 2 / 12', 'type-c · 0 / ≥ 3,300']);
    expect(drawn[0]).toMatchObject({ nodeKey: anchorKey, neighborType: 'kind-b', name: 'kind-b', figures: '2 / 12' });
    expect(drawn[1]).toMatchObject({ name: 'type-c', figures: '0 / ≥ 3,300' });
    expect(drawn[1]?.spoken).toBe('type-c: 0 of ≥ 3,300 relationships loaded, not all loaded');
  });

  it('counts a relationship from the node to itself at both of its ends in the figure of its own type, as the degree total counts it', () => {
    const selfLoop: GraphEdge = { ...edgeTo('self', 'type-a'), to: anchor, ref: { sourceId: 'a', type: 'link-a', from: 'type-a', to: 'type-a', stableId: 'self' } };
    const drawn = aggregateNodesOf(input({ graph: graph([edgeTo('r1'), selfLoop]), preview: previewOf({ byNeighborType: [{ entityType: 'type-a', count: count(5, 'exact') }] }), mapped: () => ['type-a'] }));
    expect(drawn.map((item) => item.figures)).toEqual(['2 / 5']);
  });

  it('uses the entity type\'s display name as the profile gives it, without pluralising', () => {
    const drawn = aggregateNodesOf(input({ graph: graph([edgeTo('r1', 'type-a')]), preview: previewOf({ byNeighborType: [{ entityType: 'type-a', count: count(5, 'exact') }] }), mapped: () => [] }));
    expect(drawn.map((item) => item.label)).toEqual(['TYPE-A · 1 / 5']);
  });

  it('names an estimated total with its tilde and says "loaded" alone when the total has no number but pages were read', () => {
    const estimated = aggregateNodesOf(input({ preview: previewOf({ byNeighborType: [{ entityType: 'kind-b', count: count(40, 'estimated') }] }) }));
    expect(estimated[0]?.label).toBe('kind-b · 2 / ~ 40');
    const unknown = aggregateNodesOf(input({ preview: previewOf({ byNeighborType: [{ entityType: 'kind-b', count: count(undefined, 'unknown') }] }), expansionOf: () => idle([['kind-b', {}]]) }));
    expect(unknown.map((item) => item.label)).toEqual(['kind-b · 2 loaded']);
  });

  it('draws none for a type with no count when nothing was read', () => {
    expect(aggregateNodesOf(input({ preview: previewOf({ byNeighborType: [{ entityType: 'kind-b', count: count(undefined, 'unknown') }] }) }))).toEqual([]);
  });

  it.each([
    ['a node that is not touched', { touched: new Set<string>() }],
    ['a node with no held preview', { previewOf: () => undefined }],
  ])('draws none for %s', (_, overrides) => {
    expect(aggregateNodesOf(input(overrides))).toEqual([]);
  });

  it('keeps one for a lower-bound total that what is loaded has reached, since the source may hold more', () => {
    const drawn = aggregateNodesOf(input({ graph: graph(Array.from({ length: 12 }, (_, at) => edgeTo(`r${at}`))), preview: previewOf({ byNeighborType: [{ entityType: 'kind-b', count: count(12, 'lowerBound') }] }) }));
    expect(drawn.map((item) => item.label)).toEqual(['kind-b · 12 / ≥ 12']);
  });

  it('carries the total with its quality in words in the detail, the hover tip reads', () => {
    expect(aggregateNodesOf(input()).map((item) => item.detail)).toEqual(['total 12 · exact', 'total ≥ 3,300 · lower bound']);
    const estimated = aggregateNodesOf(input({ preview: previewOf({ byNeighborType: [{ entityType: 'kind-b', count: count(40, 'estimated') }] }) }));
    expect(estimated[0]).toMatchObject({ label: 'kind-b · 2 / ~ 40', detail: 'total ~ 40 (estimated)' });
  });

  it('draws none for a type whose remainder is exactly zero, and none when the pages over all sourced types have ended', () => {
    const full = aggregateNodesOf(input({ graph: graph(Array.from({ length: 12 }, (_, at) => edgeTo(`r${at}`))) }));
    expect(full.map((item) => item.neighborType)).toEqual(['type-c']);
    const ended = aggregateNodesOf(input({ expansionOf: () => idle([['kind-b', { hasMore: false, cursor: undefined }]]) }));
    expect(ended.map((item) => item.neighborType)).toEqual(['type-c']);
  });

  it('keeps one when only a chain narrowed to a relationship type has ended', () => {
    const narrowed = aggregateNodesOf(input({ expansionOf: () => idle([['kind-b', { hasMore: false, cursor: undefined }]]), relTypesOf: () => ['link-a'] }));
    expect(narrowed.map((item) => item.neighborType)).toEqual(['kind-b', 'type-c']);
  });

  it('keeps one when what is loaded is not exact, so a remainder cannot be shown to be zero', () => {
    const aggregateEdge: GraphEdge = { ...edgeTo('x'), ref: { sourceId: 'a', aggregate: { type: 'link-a', from: anchor, to: ref('a', 'kind-b', 'bx') } }, memberCount: count(12, 'lowerBound') };
    const drawn = aggregateNodesOf(input({ graph: graph([aggregateEdge]) }));
    expect(drawn.find((item) => item.neighborType === 'kind-b')?.label).toBe('kind-b · ≥ 12 / 12');
  });

  it('draws the mapped neighbor types in the order of the profile, then the others the preview names', () => {
    const drawn = aggregateNodesOf(input({ mapped: () => ['type-c', 'kind-b'] }));
    expect(drawn.map((item) => item.neighborType)).toEqual(['type-c', 'kind-b']);
  });
});

describe('the keys of aggregate nodes', () => {
  it('name their node and neighbor type, and are never read as another key', () => {
    expect(parseAggregateKey(aggregateKey(anchorKey, 'kind-b'))).toEqual({ nodeKey: anchorKey, neighborType: 'kind-b' });
    expect(parseAggregateKey(anchorKey)).toBeUndefined();
    expect(parseAggregateKey(aggregateLinkKey(anchorKey, 'kind-b'))).toBeUndefined();
    expect(parseAggregateKey('not json')).toBeUndefined();
  });
});
