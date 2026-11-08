import { describe, expect, it } from 'vitest';
import { createClientState, type ClientState } from './client-state.js';
import { edgeKey, elementKey } from './keys.js';
import { visibleGraph } from './loaded-graph.js';
import { edgeRef, key, ref, result } from './test-data.js';

const nodeKey = (id: string): string => elementKey(ref('a', 'type-a', id));
const linkKey = (id: string): string => edgeKey(edgeRef('a', id));

function load(): ClientState {
  const state = createClientState();
  const links: Array<[string, string, string]> = [['e0', 'n0', 'n1'], ['e1', 'n1', 'n2']];
  state.bindSource('a');
  state.putResult(key('a'), result('a', ['n0', 'n1', 'n2'], links));
  state.setLoaded([key('a')], ['n0', 'n1', 'n2'].map((id) => ref('a', 'type-a', id)), links.map(([id]) => edgeRef('a', id)));
  return state;
}

describe('the hidden entities', () => {
  it('are refused when the key is not a loaded entity, or is a relationship, and change nothing', () => {
    const state = load();
    const before = state.presentation.view.getState();
    expect(() => state.hide([nodeKey('n9')])).toThrowError(expect.objectContaining({ code: 'UNKNOWN_ELEMENT' }));
    expect(() => state.hide([linkKey('e0')])).toThrowError(expect.objectContaining({ code: 'UNKNOWN_ELEMENT' }));
    expect(state.presentation.view.getState()).toBe(before);
  });

  it('take the entity and the selected relationships that touch it out of the selection, and leave the other selected relationships', () => {
    const state = load();
    state.presentation.select([nodeKey('n0'), nodeKey('n2'), linkKey('e0'), linkKey('e1')]);
    state.hide([nodeKey('n0')]);
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n2'), linkKey('e1')]);
  });

  it('end a walk standing on the entity or its relationship, and close its panel and its menu, but keep its pin', () => {
    const state = load();
    state.presentation.pin([nodeKey('n1')]);
    state.presentation.walkTo(nodeKey('n1'));
    state.presentation.setSupernodePanel({ key: nodeKey('n1') });
    state.presentation.setOpenMenu({ kind: 'node', key: nodeKey('n1'), x: 1, y: 1 });
    state.hide([nodeKey('n1')]);
    const now = state.presentation.view.getState();
    expect(now.focused).toBeUndefined();
    expect(now.supernodePanel).toBeUndefined();
    expect(now.openMenu).toBeUndefined();
    expect(now.pins.has(nodeKey('n1'))).toBe(true);
    state.presentation.walkTo(nodeKey('n2'));
    state.hide([nodeKey('n0')]);
    expect(state.presentation.view.getState().focused).toBe(nodeKey('n2'));
  });

  it('give a graph without them and without the relationships that touch them, and the same object for the same inputs', () => {
    const state = load();
    state.hide([nodeKey('n0')]);
    const graph = state.visibleGraph();
    expect(graph.nodes.map((node) => elementKey(node.ref))).toEqual([nodeKey('n1'), nodeKey('n2')]);
    expect(graph.edges.map((edge) => edgeKey(edge.ref))).toEqual([linkKey('e1')]);
    expect(state.visibleGraph()).toBe(graph);
    expect(graph.entities).toBe(state.loadedGraph().entities);
    expect(visibleGraph(state.loadedGraph(), new Set())).toBe(state.loadedGraph());
  });

  it('are dropped with the entity that is no longer loaded, and when another source is bound', () => {
    const state = load();
    state.hide([nodeKey('n1')]);
    const snapshot = state.presentation.view.getState().hidden;
    expect([...snapshot]).toEqual([nodeKey('n1')]);
    state.setLoaded([key('a')], [ref('a', 'type-a', 'n0')], []);
    expect(state.presentation.view.getState().hidden.size).toBe(0);
    state.bindSource('b');
    expect(state.presentation.view.getState().hidden.size).toBe(0);
  });

  it('stay hidden when an expansion loads them again, and show again all at once', () => {
    const state = load();
    state.hide([nodeKey('n1')]);
    state.putResult(key('a', 'seed-2'), result('a', ['n1', 'n3'], []));
    state.setLoaded([key('a'), key('a', 'seed-2')], ['n0', 'n1', 'n2', 'n3'].map((id) => ref('a', 'type-a', id)), [edgeRef('a', 'e0'), edgeRef('a', 'e1')]);
    expect(state.presentation.view.getState().hidden.has(nodeKey('n1'))).toBe(true);
    expect(state.visibleGraph().nodes).toHaveLength(3);
    state.presentation.showAllHidden();
    expect(state.visibleGraph().nodes).toHaveLength(4);
  });
});
