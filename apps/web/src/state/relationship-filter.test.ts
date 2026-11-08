import { describe, expect, it } from 'vitest';
import { createClientState, type ClientState } from './client-state.js';
import { edgeKey, elementKey } from './keys.js';
import { edge, key, node, ref } from './test-data.js';

const n = (id: string): string => elementKey(ref('a', 'type-a', id));

function load(): ClientState {
  const state = createClientState();
  const nodes = [node('a', 'n0'), node('a', 'n1'), node('a', 'n2')];
  const edges = [{ ...edge('a', 'e0', 'n0', 'n1'), type: 'link-a' }, { ...edge('a', 'e1', 'n1', 'n2'), type: 'link-b' }];
  state.bindSource('a');
  state.putResult(key('a'), { sourceId: 'a', nodes, edges });
  state.setLoaded([key('a')], nodes.map((candidate) => candidate.ref), edges.map((candidate) => candidate.ref));
  state.presentation.setMappedTypes({ entityTypes: ['type-a'], relationshipTypes: ['link-a', 'link-b'] });
  return state;
}

const linkKeys = (state: ClientState): string[] => state.loadedGraph().edges.map((candidate) => edgeKey(candidate.ref));

describe('the relationship type filter', () => {
  it('refuses a type the mapping does not name and changes nothing', () => {
    const state = load();
    const before = state.presentation.view.getState();
    expect(() => state.setRelationshipTypeOff('link-z', true)).toThrowError(expect.objectContaining({ code: 'UNKNOWN_TYPE' }));
    expect(state.presentation.view.getState()).toBe(before);
  });

  it('leaves the relationships of an off type out of the view and every entity in it, and keeps them loaded', () => {
    const state = load();
    state.setRelationshipTypeOff('link-a', true);
    expect(state.visibleGraph().edges.map((candidate) => candidate.type)).toEqual(['link-b']);
    expect(state.visibleGraph().nodes).toHaveLength(3);
    expect(state.loadedGraph().edges).toHaveLength(2);
    expect(state.loadedGraph().relationships.value).toBe(2);
    state.setRelationshipTypeOff('link-a', false);
    expect(state.visibleGraph()).toBe(state.loadedGraph());
  });

  it('takes a selected relationship of the type out of the selection, ends a walk on one and closes a menu on one, and leaves the rest', () => {
    const state = load();
    const [first, second] = linkKeys(state);
    if (first === undefined || second === undefined) throw new Error('no links');
    state.presentation.select([first, second, n('n0')]);
    state.presentation.walkTo(first);
    state.presentation.setOpenMenu({ kind: 'relationship', key: first, x: 1, y: 1 });
    state.setRelationshipTypeOff('link-a', true);
    const now = state.presentation.view.getState();
    expect([...now.selection].sort()).toEqual([second, n('n0')].sort());
    expect(now.focused).toBeUndefined();
    expect(now.openMenu).toBeUndefined();
  });

  it('keeps a relationship of an off type that comes with an expansion loaded and not drawn', () => {
    const state = load();
    state.setRelationshipTypeOff('link-b', true);
    const nodes = state.loadedGraph().nodes;
    const more = [...state.loadedGraph().edges, { ...edge('a', 'e2', 'n0', 'n2'), type: 'link-b' }];
    state.putResult(key('a', 'seed-2'), { sourceId: 'a', nodes: [...nodes], edges: more });
    state.setLoaded([key('a'), key('a', 'seed-2')], nodes.map((candidate) => candidate.ref), more.map((candidate) => candidate.ref));
    expect(state.loadedGraph().edges).toHaveLength(3);
    expect(state.visibleGraph().edges.map((candidate) => candidate.type)).toEqual(['link-a']);
  });

  it('is cleared on a reset of the filter along with the entity types', () => {
    const state = load();
    state.setRelationshipTypeOff('link-a', true);
    state.presentation.resetTypeFilter();
    expect(state.presentation.view.getState().typeFilter.offRelationshipTypes.size).toBe(0);
  });

  it('is dropped for a type the mapping stops naming, and is gone when another source is bound', () => {
    const state = load();
    state.setRelationshipTypeOff('link-a', true);
    state.setRelationshipTypeOff('link-b', true);
    state.presentation.setMappedTypes({ entityTypes: ['type-a'], relationshipTypes: ['link-b'] });
    expect([...state.presentation.view.getState().typeFilter.offRelationshipTypes]).toEqual(['link-b']);
    state.bindSource('b');
    expect(state.presentation.view.getState().typeFilter.offRelationshipTypes.size).toBe(0);
  });
});
