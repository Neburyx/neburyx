import type { GraphNode } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createClientState, type ClientState } from './client-state.js';
import { edgeKey, elementKey } from './keys.js';
import { excludedKeys, filteredKeys, visibleGraph } from './loaded-graph.js';
import { NO_TYPE_FILTER } from './presentation-state.js';
import { createPresentationStore } from './presentation-state.js';
import { edge, key, node, ref } from './test-data.js';

const typed = (id: string, entityType: string): GraphNode => ({ ...node('a', id), ref: ref('a', entityType, id), display: { title: id, type: entityType } });
const link = (id: string, from: [string, string], to: [string, string]) => ({ ...edge('a', id, from[0], to[0]), from: ref('a', from[1], from[0]), to: ref('a', to[1], to[0]) });
const keyOf = (id: string, entityType: string): string => elementKey(ref('a', entityType, id));

function load(): ClientState {
  const state = createClientState();
  const nodes = [typed('n0', 'kind-a'), typed('n1', 'kind-a'), typed('n2', 'kind-b'), typed('n3', 'kind-c')];
  const edges = [link('e0', ['n0', 'kind-a'], ['n2', 'kind-b']), link('e1', ['n1', 'kind-a'], ['n3', 'kind-c']), link('e2', ['n2', 'kind-b'], ['n3', 'kind-c'])];
  state.bindSource('a');
  state.putResult(key('a'), { sourceId: 'a', nodes, edges });
  state.setLoaded([key('a')], nodes.map((candidate) => candidate.ref), edges.map((candidate) => candidate.ref));
  state.presentation.setMappedTypes({ entityTypes: ['kind-a', 'kind-b', 'kind-c'], relationshipTypes: ['rel-a'] });
  return state;
}

describe('the entity type filter', () => {
  it('refuses a type the mapping does not name, or any type before the mapping is known, and changes nothing', () => {
    const state = load();
    const before = state.presentation.view.getState();
    expect(() => state.setEntityTypeOff('kind-z', true)).toThrowError(expect.objectContaining({ code: 'UNKNOWN_TYPE' }));
    expect(state.presentation.view.getState()).toBe(before);
    state.presentation.setMappedTypes(undefined);
    expect(() => state.setEntityTypeOff('kind-a', true)).toThrowError(expect.objectContaining({ code: 'UNKNOWN_TYPE' }));
  });

  it('keeps every entity loaded and leaves the entities of an off type, and the relationships that touch them, out of the view', () => {
    const state = load();
    state.setEntityTypeOff('kind-a', true);
    const visible = state.visibleGraph();
    expect(visible.nodes.map((n) => n.ref.stableId)).toEqual(['n2', 'n3']);
    expect(visible.edges.map((candidate) => candidate.type)).toEqual(['rel-a']);
    expect(state.loadedGraph().nodes).toHaveLength(4);
    expect(state.loadedGraph().entities.value).toBe(4);
    state.setEntityTypeOff('kind-a', false);
    expect(state.visibleGraph().nodes).toHaveLength(4);
    expect(state.visibleGraph().edges).toHaveLength(3);
  });

  it('takes the entity and the selected relationships that touch it out of the selection, ends the walk on it and closes its panel and menu, and keeps its pin', () => {
    const state = load();
    const linkKeys = state.loadedGraph().edges.map((candidate) => edgeKey(candidate.ref));
    expect(linkKeys).toHaveLength(3);
    state.presentation.pin([keyOf('n0', 'kind-a')]);
    state.presentation.select([keyOf('n0', 'kind-a'), keyOf('n2', 'kind-b'), keyOf('n3', 'kind-c'), ...linkKeys]);
    state.presentation.walkTo(keyOf('n1', 'kind-a'));
    state.presentation.setSupernodePanel({ key: keyOf('n0', 'kind-a') });
    state.presentation.setOpenMenu({ kind: 'node', key: keyOf('n1', 'kind-a'), x: 1, y: 1 });
    state.setEntityTypeOff('kind-a', true);
    const now = state.presentation.view.getState();
    expect([...now.selection].sort()).toEqual([keyOf('n2', 'kind-b'), keyOf('n3', 'kind-c'), linkKeys[2]].sort());
    expect(now.focused).toBeUndefined();
    expect(now.supernodePanel).toBeUndefined();
    expect(now.openMenu).toBeUndefined();
    expect(now.pins.has(keyOf('n0', 'kind-a'))).toBe(true);
  });

  it('leaves a walk on, a menu on and a panel on an entity of another type alone', () => {
    const state = load();
    state.presentation.walkTo(keyOf('n2', 'kind-b'));
    state.presentation.setSupernodePanel({ key: keyOf('n3', 'kind-c') });
    state.setEntityTypeOff('kind-a', true);
    expect(state.presentation.view.getState().focused).toBe(keyOf('n2', 'kind-b'));
    expect(state.presentation.view.getState().supernodePanel?.key).toBe(keyOf('n3', 'kind-c'));
  });

  it('keeps an entity of an off type filtered when it comes with an expansion, and keeps the type off when no entity of it is loaded', () => {
    const state = load();
    state.setEntityTypeOff('kind-c', true);
    const nodes = [typed('n0', 'kind-a'), typed('n1', 'kind-a'), typed('n2', 'kind-b')];
    state.setLoaded([key('a')], nodes.map((candidate) => candidate.ref), []);
    expect(state.presentation.view.getState().typeFilter.offEntityTypes.has('kind-c')).toBe(true);
    const more = [...nodes, typed('n4', 'kind-c')];
    state.putResult(key('a', 'seed-2'), { sourceId: 'a', nodes: more, edges: [] });
    state.setLoaded([key('a'), key('a', 'seed-2')], more.map((candidate) => candidate.ref), []);
    expect(state.loadedGraph().nodes).toHaveLength(4);
    expect(state.visibleGraph().nodes.map((n) => n.ref.stableId)).not.toContain('n4');
  });

  it('drops an off type the mapping stops naming, and nothing else', () => {
    const state = load();
    state.setEntityTypeOff('kind-a', true);
    state.setEntityTypeOff('kind-b', true);
    state.presentation.setMappedTypes({ entityTypes: ['kind-a', 'kind-c'], relationshipTypes: [] });
    expect([...state.presentation.view.getState().typeFilter.offEntityTypes]).toEqual(['kind-a']);
  });

  it('is gone when another source is bound', () => {
    const state = load();
    state.setEntityTypeOff('kind-a', true);
    const snapshot = state.presentation.view.getState().typeFilter;
    expect(snapshot.offEntityTypes.has('kind-a')).toBe(true);
    state.bindSource('b');
    expect(state.presentation.view.getState().typeFilter).toBe(NO_TYPE_FILTER);
  });

  it('keeps the filter while the mapping is unknown, and when the same mapping is known again', () => {
    const state = load();
    state.setEntityTypeOff('kind-a', true);
    state.setRelationshipTypeOff('rel-a', true);
    const kept = state.presentation.view.getState().typeFilter;
    state.presentation.setMappedTypes(undefined);
    expect(state.presentation.view.getState().typeFilter).toBe(kept);
    expect(state.visibleGraph().nodes.map((entry) => entry.ref.stableId)).toEqual(['n2', 'n3']);
    state.presentation.setMappedTypes({ entityTypes: ['kind-a', 'kind-b', 'kind-c'], relationshipTypes: ['rel-a'] });
    expect(state.presentation.view.getState().typeFilter).toBe(kept);
  });

  it('comes back when the investigation is resumed in the session, and is gone when another is opened fresh', () => {
    const state = createClientState();
    const opened = (id: string, params: string) => {
      const nodes = [typed(`${id}-0`, 'kind-a'), typed(`${id}-1`, 'kind-b')];
      return { loaded: { id, sourceId: 'a', record: { title: id, caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' as const } }, resultKeys: [key('a', params)], nodeRefs: nodes.map((entry) => entry.ref), edgeRefs: [] }, results: [{ key: key('a', params), result: { sourceId: 'a', nodes, edges: [] } }] };
    };
    const first = opened('inv-1', 'p1');
    const second = opened('inv-2', 'p2');
    expect(state.show(first.loaded, first.results)).toBe('fresh');
    state.presentation.setMappedTypes({ entityTypes: ['kind-a', 'kind-b'], relationshipTypes: ['rel-a'] });
    state.setEntityTypeOff('kind-a', true);
    state.setRelationshipTypeOff('rel-a', true);
    expect(state.show(second.loaded, second.results)).toBe('fresh');
    expect(state.presentation.view.getState().typeFilter).toBe(NO_TYPE_FILTER);
    expect(state.show(first.loaded, first.results)).toBe('resumed');
    expect([...state.presentation.view.getState().typeFilter.offEntityTypes]).toEqual(['kind-a']);
    expect([...state.presentation.view.getState().typeFilter.offRelationshipTypes]).toEqual(['rel-a']);
  });

  it('resets every type on and does nothing when none is off', () => {
    const state = load();
    const before = state.presentation.view.getState();
    state.presentation.resetTypeFilter();
    expect(state.presentation.view.getState()).toBe(before);
    state.setEntityTypeOff('kind-a', true);
    state.presentation.resetTypeFilter();
    expect(state.presentation.view.getState().typeFilter.offEntityTypes.size).toBe(0);
  });

  it('goes with the snapshot of an investigation set aside, and comes back with it', () => {
    const store = createPresentationStore({ isNode: () => true, isElement: () => true });
    store.setMappedTypes({ entityTypes: ['kind-a', 'kind-b'], relationshipTypes: [] });
    store.setEntityTypeOff('kind-b', true);
    const snapshot = store.snapshot();
    store.reset();
    expect(store.view.getState().typeFilter).toBe(NO_TYPE_FILTER);
    store.restore(snapshot);
    expect(store.view.getState().typeFilter.offEntityTypes.has('kind-b')).toBe(true);
  });

  it('builds one filtered set and one combined set for the same inputs', () => {
    const state = load();
    state.setEntityTypeOff('kind-a', true);
    const graph = state.loadedGraph();
    const { typeFilter, hidden } = state.presentation.view.getState();
    const filtered = filteredKeys(graph, typeFilter);
    expect(filteredKeys(graph, typeFilter)).toBe(filtered);
    expect(filtered.size).toBe(2);
    expect(filteredKeys(graph, NO_TYPE_FILTER).size).toBe(0);
    state.hide([keyOf('n2', 'kind-b')]);
    const hiddenNow = state.presentation.view.getState().hidden;
    const union = excludedKeys(graph, { hidden: hiddenNow, neighborhoodFocus: undefined, filtered });
    expect(union.size).toBe(3);
    expect(excludedKeys(graph, { hidden: hiddenNow, neighborhoodFocus: undefined, filtered })).toBe(union);
    expect([...excludedKeys(graph, { hidden, neighborhoodFocus: undefined, filtered })].sort()).toEqual([...filtered].sort());
    expect(visibleGraph(graph, union).nodes.map((n) => n.ref.stableId)).toEqual(['n3']);
  });

  it('shows everything drawn for an empty filter: all types on is the same graph', () => {
    const state = load();
    expect(state.visibleGraph()).toBe(state.loadedGraph());
  });

  it('ends the neighborhood focus when the type of the focused entity is switched off, and brings the earlier view back', () => {
    const state = load();
    state.presentation.setViewport({ zoom: 2, x: 5, y: 6 });
    state.focusOn(keyOf('n0', 'kind-a'));
    expect(state.presentation.view.getState().neighborhoodFocus).toBe(keyOf('n0', 'kind-a'));
    state.setEntityTypeOff('kind-a', true);
    const now = state.presentation.view.getState();
    expect(now.neighborhoodFocus).toBeUndefined();
    expect(now.focusReturn).toBeUndefined();
    expect(now.viewport).toEqual({ zoom: 2, x: 5, y: 6 });
    expect(now.moveNote?.text).toBe('Focus left.');
    expect(state.visibleGraph().nodes.map((entry) => entry.ref.stableId)).toEqual(['n2', 'n3']);
  });

  it('keeps the focus when the type switched off is not the focused entity\'s', () => {
    const state = load();
    state.focusOn(keyOf('n0', 'kind-a'));
    state.setEntityTypeOff('kind-c', true);
    expect(state.presentation.view.getState().neighborhoodFocus).toBe(keyOf('n0', 'kind-a'));
  });
});
