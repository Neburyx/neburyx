import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { elementKey, edgeKey } from '../state/keys.js';
import { edge, edgeRef, key, ref, result } from '../state/test-data.js';
import { buildScene } from './build-scene.js';

function loaded(nodes: readonly string[], edges: ReadonlyArray<readonly [string, string, string]>, withNodes = nodes) {
  const state = createClientState();
  state.bindSource('a');
  state.putResult(key('a'), result('a', nodes, edges));
  state.setLoaded([key('a')], withNodes.map((id) => ref('a', 'type-a', id)), edges.map(([id]) => edgeRef('a', id)));
  return state;
}

describe('the scene of the canvas', () => {
  it('holds an entity and a relationship for each loaded one, with the positions the presentation state has', () => {
    const state = loaded(['n1', 'n2'], [['e1', 'n1', 'n2']]);
    const first = elementKey(ref('a', 'type-a', 'n1'));
    const scene = buildScene(state.loadedGraph(), new Map([[first, { x: 3, y: 4 }]]), undefined, new Set(), 'select', null);
    expect(scene.entities.map((entity) => entity.position)).toEqual([{ x: 3, y: 4 }, undefined]);
    expect(scene.relationships).toEqual([{ id: edgeKey(edgeRef('a', 'e1')), from: first, to: elementKey(ref('a', 'type-a', 'n2')), look: { aggregate: false, origin: 'stored', label: undefined } }]);
  });

  it('leaves out a relationship whose entity is not loaded', () => {
    const state = loaded(['n1', 'n2'], [['e1', 'n1', 'n2']], ['n1']);
    const scene = buildScene(state.loadedGraph(), new Map(), undefined, new Set(), 'select', null);
    expect(scene.entities).toHaveLength(1);
    expect(scene.relationships).toEqual([]);
  });

  it('passes the profile on as it is', () => {
    const state = loaded(['n1'], []);
    expect(buildScene(state.loadedGraph(), new Map(), undefined, new Set(), 'select', null).profile).toBeUndefined();
  });

  it('makes distinct identifiers for the edge helper used in the tests', () => {
    expect(edge('a', 'e1', 'n1', 'n2').ref).toEqual(edgeRef('a', 'e1'));
  });

  it('gives each relationship its look from its edge, with or without a profile, since the type name is the profile\'s own identifier', () => {
    const state = loaded(['n1', 'n2'], [['e1', 'n1', 'n2']]);
    const without = buildScene(state.loadedGraph(), new Map(), undefined, new Set(), 'select', null).relationships[0]?.look;
    expect(without).toEqual({ aggregate: false, origin: 'stored', label: undefined });
  });

  it('labels a stored relationship with its type while either entity it joins is selected, and not when only the relationship or another entity is', () => {
    const state = loaded(['n1', 'n2', 'n3'], [['e1', 'n1', 'n2']]);
    const label = (selected: readonly string[]) => buildScene(state.loadedGraph(), new Map(), undefined, new Set(selected), 'select', null).relationships[0]?.look.label;
    const n1 = elementKey(ref('a', 'type-a', 'n1'));
    const n2 = elementKey(ref('a', 'type-a', 'n2'));
    const n3 = elementKey(ref('a', 'type-a', 'n3'));
    expect(label([])).toBeUndefined();
    expect(label([n1])).toBe('rel-a');
    expect(label([n2])).toBe('rel-a');
    expect(label([n3])).toBeUndefined();
    expect(label([edgeKey(edgeRef('a', 'e1'))])).toBeUndefined();
    expect(label([n1])).toBe('rel-a');
    expect(label([])).toBeUndefined();
  });
});
