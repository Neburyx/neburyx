import { describe, expect, it, vi } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { edge, key, node } from '../state/test-data.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { heldKeysOf, mergeIntoLoaded } from './merge-into-loaded.js';

function held() {
  const state = createClientState();
  loadGraph(state, [node('a', 'n1'), node('a', 'n2')], [edge('a', 'e1', 'n1', 'n2')]);
  return state;
}

describe('the merge core', () => {
  it('stores only what the investigation does not hold, in one result, and returns the new and the held counts', () => {
    const state = held();
    const merged = mergeIntoLoaded(state, { sourceId: 'a', nodes: [node('a', 'n2'), node('a', 'n3')], edges: [edge('a', 'e1', 'n1', 'n2'), edge('a', 'e2', 'n2', 'n3')], queryKey: () => key('a', 'merged-1') });
    expect(merged.freshNodes.map((each) => each.ref.stableId)).toEqual(['n3']);
    expect(merged.freshEdges.map((each) => each.ref)).toEqual([edge('a', 'e2', 'n2', 'n3').ref]);
    expect({ heldNodes: merged.heldNodes, heldEdges: merged.heldEdges }).toEqual({ heldNodes: 1, heldEdges: 1 });
    expect(merged.queryKey).toEqual(key('a', 'merged-1'));
    const { nodes, edges } = heldKeysOf(state);
    expect([...nodes].sort()).toEqual(['n1', 'n2', 'n3'].map((id) => elementKey(node('a', id).ref)).sort());
    expect(edges).toEqual(new Set([edgeKey(edge('a', 'e1', 'n1', 'n2').ref), edgeKey(edge('a', 'e2', 'n2', 'n3').ref)]));
  });

  it('never replaces an item it holds: the held entity keeps the data it had', () => {
    const state = held();
    const changed = { ...node('a', 'n1'), display: { title: 'another title', type: 'type-a' } };
    mergeIntoLoaded(state, { sourceId: 'a', nodes: [changed, node('a', 'n3')], edges: [], queryKey: () => key('a', 'merged-2') });
    expect(state.loadedGraph().nodes.find((each) => each.ref.stableId === 'n1')?.display.title).toBe('n1');
  });

  it('makes no result key and no write when nothing is new', () => {
    const state = held();
    const before = state.investigation.getState();
    const queryKey = vi.fn(() => key('a', 'unused'));
    const merged = mergeIntoLoaded(state, { sourceId: 'a', nodes: [node('a', 'n1')], edges: [edge('a', 'e1', 'n1', 'n2')], queryKey });
    expect(queryKey).not.toHaveBeenCalled();
    expect(merged.queryKey).toBeUndefined();
    expect(state.investigation.getState()).toBe(before);
  });

  it('makes one setLoaded call for the whole result, so the graph never holds part of it', () => {
    const state = held();
    const spy = vi.spyOn(state, 'setLoaded');
    mergeIntoLoaded(state, { sourceId: 'a', nodes: [node('a', 'n3'), node('a', 'n4')], edges: [edge('a', 'e2', 'n2', 'n3'), edge('a', 'e3', 'n3', 'n4')], queryKey: () => key('a', 'merged-3') });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses a result of another source with SOURCE_MISMATCH and leaves the graph as it was', () => {
    const state = held();
    const before = state.loadedGraph();
    expect(() => mergeIntoLoaded(state, { sourceId: 'b', nodes: [node('b', 'x1')], edges: [], queryKey: () => key('b', 'merged-4') })).toThrow();
    expect(state.loadedGraph()).toEqual(before);
  });
});
