import { describe, expect, it } from 'vitest';
import { createClientState, type ClientState } from './client-state.js';
import { edgeKey, elementKey } from './keys.js';
import { excludedKeys, neighborhoodOf, outsideFocusKeys, visibleGraph } from './loaded-graph.js';
import { edgeRef, key, ref, result } from './test-data.js';
import { shownCount } from '../workspace/scope-text.js';

const nodeKey = (id: string): string => elementKey(ref('a', 'type-a', id));
const linkKey = (id: string): string => edgeKey(edgeRef('a', id));
const IDS = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
const LINKS: Array<[string, string, string]> = [['e0', 'n0', 'n1'], ['e1', 'n1', 'n2'], ['e2', 'n2', 'n3'], ['e3', 'n4', 'n1'], ['e4', 'n0', 'n2']];

function load(): ClientState {
  const state = createClientState();
  state.bindSource('a');
  state.putResult(key('a'), result('a', IDS, LINKS));
  state.setLoaded([key('a')], IDS.map((id) => ref('a', 'type-a', id)), LINKS.map(([id]) => edgeRef('a', id)));
  return state;
}

const drawnIds = (state: ClientState): string[] => state.visibleGraph().nodes.map((node) => elementKey(node.ref));

describe('the neighborhood focus', () => {
  it('draws the entity, its neighbors by either direction and the relationships among them, and nothing else', () => {
    const state = load();
    state.focusOn(nodeKey('n1'));
    expect(drawnIds(state)).toEqual(['n0', 'n1', 'n2', 'n4'].map(nodeKey));
    expect(state.visibleGraph().edges.map((edge) => edgeKey(edge.ref))).toEqual(['e0', 'e1', 'e3', 'e4'].map(linkKey));
    expect(state.visibleGraph().entities).toBe(state.loadedGraph().entities);
    expect(state.visibleGraph()).toBe(state.visibleGraph());
  });

  it('shows an entity with no neighbors alone', () => {
    const state = load();
    state.focusOn(nodeKey('n5'));
    expect(drawnIds(state)).toEqual([nodeKey('n5')]);
  });

  it('counts an entity that is hidden and outside focus once, and keeps the loaded count', () => {
    const state = load();
    state.hide([nodeKey('n3'), nodeKey('n0')]);
    state.focusOn(nodeKey('n1'));
    const graph = state.loadedGraph();
    const loaded = graph.nodes.map((node) => elementKey(node.ref));
    const hidden = state.presentation.view.getState().hidden;
    const outside = outsideFocusKeys(graph, nodeKey('n1'), hidden);
    expect([...outside].sort()).toEqual([nodeKey('n5')]);
    expect(shownCount(loaded, hidden, new Set(), outside)).toBe(3);
    expect(graph.entities.value).toBe(6);
    expect(drawnIds(state)).toEqual(['n1', 'n2', 'n4'].map(nodeKey));
  });

  it('keeps a hidden neighbor hidden, and draws a shown one again only if it is in the neighborhood', () => {
    const state = load();
    state.focusOn(nodeKey('n1'));
    state.hide([nodeKey('n2')]);
    expect(drawnIds(state)).not.toContain(nodeKey('n2'));
    state.presentation.showAllHidden();
    expect(drawnIds(state)).toContain(nodeKey('n2'));
    state.hide([nodeKey('n3')]);
    state.presentation.showAllHidden();
    expect(drawnIds(state)).not.toContain(nodeKey('n3'));
  });

  it('takes what it sets aside out of the selection, the walk, the menu and the panel, and keeps its pins', () => {
    const state = load();
    state.presentation.pin([nodeKey('n3')]);
    state.presentation.select([nodeKey('n0'), nodeKey('n3'), linkKey('e2'), linkKey('e0')]);
    state.presentation.walkTo(nodeKey('n3'));
    state.presentation.setSupernodePanel({ key: nodeKey('n3') });
    state.presentation.setOpenMenu({ kind: 'node', key: nodeKey('n5'), x: 1, y: 1 });
    state.focusOn(nodeKey('n1'));
    const now = state.presentation.view.getState();
    expect([...now.selection]).toEqual([nodeKey('n0'), linkKey('e0')]);
    expect(now.focused).toBeUndefined();
    expect(now.supernodePanel).toBeUndefined();
    expect(now.openMenu).toBeUndefined();
    expect(now.pins.has(nodeKey('n3'))).toBe(true);
  });

  it('ends a walk on a relationship that touches a set-aside entity', () => {
    const state = load();
    state.presentation.walkTo(linkKey('e2'));
    state.focusOn(nodeKey('n1'));
    expect(state.presentation.view.getState().focused).toBeUndefined();
  });

  it('refuses a key that is hidden, not loaded, or a relationship, and changes nothing', () => {
    const state = load();
    state.hide([nodeKey('n3')]);
    const before = state.presentation.view.getState();
    expect(() => state.focusOn(nodeKey('n3'))).toThrowError(expect.objectContaining({ code: 'UNKNOWN_ELEMENT' }));
    expect(() => state.focusOn(nodeKey('n9'))).toThrowError(expect.objectContaining({ code: 'UNKNOWN_ELEMENT' }));
    expect(() => state.focusOn(linkKey('e0'))).toThrowError(expect.objectContaining({ code: 'UNKNOWN_ELEMENT' }));
    expect(() => state.focusOn('aggregate:n1:type-a')).toThrowError(expect.objectContaining({ code: 'UNKNOWN_ELEMENT' }));
    expect(state.presentation.view.getState()).toBe(before);
  });

  it('puts back the viewport from before the first entry, also after a re-focus, and sets nothing else back', () => {
    const state = load();
    state.presentation.setViewport({ zoom: 2, x: 5, y: 6 });
    state.focusOn(nodeKey('n1'));
    state.presentation.setViewport({ zoom: 1, x: 0, y: 0 });
    state.presentation.setPosition(nodeKey('n0'), { x: 9, y: 9 });
    state.hide([nodeKey('n4')]);
    state.presentation.pin([nodeKey('n2')]);
    state.focusOn(nodeKey('n2'));
    state.presentation.leaveFocus();
    const now = state.presentation.view.getState();
    expect(now.viewport).toEqual({ zoom: 2, x: 5, y: 6 });
    expect(now.neighborhoodFocus).toBeUndefined();
    expect(now.focusReturn).toBeUndefined();
    expect(now.positions.get(nodeKey('n0'))).toEqual({ x: 9, y: 9 });
    expect([...now.hidden]).toEqual([nodeKey('n4')]);
    expect(now.pins.has(nodeKey('n2'))).toBe(true);
    expect(drawnIds(state)).toEqual(['n0', 'n1', 'n2', 'n3', 'n5'].map(nodeKey));
  });

  it('ends when the focused entity is hidden or no longer loaded, with the viewport back', () => {
    const state = load();
    state.presentation.setViewport({ zoom: 2, x: 5, y: 6 });
    state.focusOn(nodeKey('n1'));
    state.hide([nodeKey('n1')]);
    expect(state.presentation.view.getState().neighborhoodFocus).toBeUndefined();
    expect(state.presentation.view.getState().viewport).toEqual({ zoom: 2, x: 5, y: 6 });
    state.presentation.showAllHidden();
    state.presentation.setViewport({ zoom: 3, x: 1, y: 1 });
    state.focusOn(nodeKey('n2'));
    state.setLoaded([key('a')], IDS.filter((id) => id !== 'n2').map((id) => ref('a', 'type-a', id)), []);
    expect(state.presentation.view.getState().neighborhoodFocus).toBeUndefined();
    expect(state.presentation.view.getState().viewport).toEqual({ zoom: 3, x: 1, y: 1 });
  });

  it('shows the new neighbor of the focused entity after an expansion and not the neighbor of a neighbor', () => {
    const state = load();
    state.focusOn(nodeKey('n5'));
    const ids = [...IDS, 'n6', 'n7'];
    const links: Array<[string, string, string]> = [...LINKS, ['e5', 'n5', 'n6'], ['e6', 'n6', 'n7']];
    state.putResult(key('a', 'seed-2'), result('a', ids, links));
    state.setLoaded([key('a'), key('a', 'seed-2')], ids.map((id) => ref('a', 'type-a', id)), links.map(([id]) => edgeRef('a', id)));
    expect(drawnIds(state)).toEqual(['n5', 'n6'].map(nodeKey));
  });

  it('is kept when another investigation is shown and this one is resumed, with the viewport held, and is gone when another source is bound', () => {
    const state = createClientState();
    const record = { title: 't', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' } } as const;
    const first = { id: 'i1', sourceId: 'a', record, resultKeys: [key('a')], nodeRefs: IDS.map((id) => ref('a', 'type-a', id)), edgeRefs: LINKS.map(([id]) => edgeRef('a', id)) };
    const second = { id: 'i2', sourceId: 'a', record, resultKeys: [key('a', 'seed-2')], nodeRefs: [ref('a', 'type-a', 'n0')], edgeRefs: [] };
    state.bindSource('a');
    state.show(first, [{ key: key('a'), result: result('a', IDS, LINKS) }]);
    state.presentation.setViewport({ zoom: 2, x: 5, y: 6 });
    state.focusOn(nodeKey('n1'));
    state.show(second, [{ key: key('a', 'seed-2'), result: result('a', ['n0']) }]);
    expect(state.presentation.view.getState().neighborhoodFocus).toBeUndefined();
    expect(state.show(first, [{ key: key('a'), result: result('a', IDS, LINKS) }])).toBe('resumed');
    expect(state.presentation.view.getState().neighborhoodFocus).toBe(nodeKey('n1'));
    state.presentation.leaveFocus();
    expect(state.presentation.view.getState().viewport).toEqual({ zoom: 2, x: 5, y: 6 });
    state.focusOn(nodeKey('n1'));
    state.bindSource('b');
    expect(state.presentation.view.getState().neighborhoodFocus).toBeUndefined();
    expect(state.presentation.view.getState().focusReturn).toBeUndefined();
  });

  it('gives hidden alone when focus is off, and the same object for the same inputs', () => {
    const state = load();
    const graph = state.loadedGraph();
    const hidden = new Set([nodeKey('n0')]);
    expect(excludedKeys(graph, { hidden, neighborhoodFocus: undefined })).toBe(hidden);
    const first = excludedKeys(graph, { hidden, neighborhoodFocus: nodeKey('n1') });
    expect(excludedKeys(graph, { hidden, neighborhoodFocus: nodeKey('n1') })).toBe(first);
    expect(visibleGraph(graph, first)).toBe(visibleGraph(graph, first));
    expect(neighborhoodOf(graph, nodeKey('n9')).size).toBe(0);
  });

  it('runs no request', () => {
    const state = load();
    const before = state.server.getState();
    state.focusOn(nodeKey('n1'));
    state.presentation.leaveFocus();
    expect(state.server.getState()).toBe(before);
  });
});
