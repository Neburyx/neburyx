import { describe, expect, it } from 'vitest';
import { testProfile } from '../dev/test-profile.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { edge, node, ref } from '../state/test-data.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import type { GraphEdge, GraphNode } from '@neburyx/contracts';
import { describeWalked, stepWalk, walkOrder } from './walk.js';

const graphOf = (nodes: GraphNode[], edges: GraphEdge[]): LoadedGraph => ({ nodes, edges, entities: { value: nodes.length, quality: 'exact', scope: 'loaded' }, relationships: { value: edges.length, quality: 'exact', scope: 'loaded' } });

describe('the order of the walk', () => {
  it('lists the entities in their order and then the relationships between two loaded entities, and leaves out one whose end is not loaded', () => {
    const graph = graphOf([node('a', 'n1'), node('a', 'n2')], [edge('a', 'e1', 'n1', 'n2'), edge('a', 'e2', 'n1', 'gone'), edge('a', 'e3', 'n2', 'n1')]);
    expect(walkOrder(graph)).toEqual([elementKey(ref('a', 'type-a', 'n1')), elementKey(ref('a', 'type-a', 'n2')), edgeKey(edge('a', 'e1', 'n1', 'n2').ref), edgeKey(edge('a', 'e3', 'n2', 'n1').ref)]);
  });

  it('is empty when nothing is loaded', () => {
    expect(walkOrder(graphOf([], []))).toEqual([]);
  });
});

describe('a step of the walk', () => {
  const order = ['a', 'b', 'c'];

  it('goes to the next or the previous element, wrapping at the ends', () => {
    expect(stepWalk(order, 'a', 1)).toBe('b');
    expect(stepWalk(order, 'c', 1)).toBe('a');
    expect(stepWalk(order, 'a', -1)).toBe('c');
    expect(stepWalk(order, 'b', -1)).toBe('a');
  });

  it('goes to the first element forward and the last backward from none, or from one that is not in the order, and nowhere when the order is empty', () => {
    expect(stepWalk(order, undefined, 1)).toBe('a');
    expect(stepWalk(order, 'gone', 1)).toBe('a');
    expect(stepWalk(order, undefined, -1)).toBe('c');
    expect(stepWalk([], undefined, 1)).toBeUndefined();
  });
});

describe('what the walk says of an element', () => {
  const pair = [{ ...node('a', 'n1'), display: { title: 'GAD-217', type: 'kind-a' }, ref: ref('a', 'kind-a', 'n1') }, { ...node('a', 'n2'), display: { title: 'Jordan Lee', type: 'kind-b' }, ref: ref('a', 'kind-b', 'n2') }];
  const link: GraphEdge = { ...edge('a', 'e1', 'n1', 'n2'), from: pair[0]?.ref ?? ref('a', 'kind-a', 'n1'), to: pair[1]?.ref ?? ref('a', 'kind-b', 'n2'), type: 'USES_GADGET', semantics: 'derived' };
  const graph = graphOf(pair, [link]);
  const first = elementKey(pair[0]?.ref ?? ref('a', 'kind-a', 'n1'));

  it('names an entity by its title and the type\'s display name, from the profile when there is one, else the type, and adds "pinned" for a pinned one', () => {
    expect(describeWalked(graph, testProfile(), new Set(), first)).toBe('GAD-217, KIND-A');
    expect(describeWalked(graph, undefined, new Set(), first)).toBe('GAD-217, kind-a');
    expect(describeWalked(graph, testProfile(), new Set([first]), first)).toBe('GAD-217, KIND-A, pinned');
  });

  it('names a relationship by its label as the canvas reads it and the titles of its two ends', () => {
    expect(describeWalked(graph, undefined, new Set(), edgeKey(link.ref))).toBe('USES_GADGET · derived, from GAD-217 to Jordan Lee');
  });

  it('says nothing of an element that is not loaded', () => {
    expect(describeWalked(graph, undefined, new Set(), 'nothing')).toBeUndefined();
  });
});

