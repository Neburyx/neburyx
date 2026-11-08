import { describe, expect, it } from 'vitest';
import { BOX_HEIGHT, BOX_WIDTH } from '../canvas/layout-constants.js';
import { layoutEntities, placeNewEntities } from '../canvas/incremental-layout.js';
import { togglePin } from '../canvas/pin-commands.js';
import { createClientState, type ClientState } from './client-state.js';
import { elementKey } from './keys.js';
import { edgeRef, key, ref, result } from './test-data.js';

const nodeKey = (id: string): string => elementKey(ref('a', 'type-a', id));
const IDS = ['n0', 'n1', 'n2', 'n3'];
const LINKS: Array<[string, string, string]> = [['e0', 'n0', 'n1'], ['e1', 'n1', 'n2'], ['e2', 'n2', 'n3']];

function load(ids: readonly string[] = IDS): ClientState {
  const state = createClientState();
  state.bindSource('a');
  state.putResult(key('a'), result('a', [...ids], LINKS.filter(([, from, to]) => ids.includes(from) && ids.includes(to))));
  state.setLoaded([key('a')], ids.map((id) => ref('a', 'type-a', id)), LINKS.filter(([, from, to]) => ids.includes(from) && ids.includes(to)).map(([id]) => edgeRef('a', id)));
  state.presentation.setPositions(new Map(ids.map((id, index) => [nodeKey(id), { x: index * 300, y: 0 }])));
  return state;
}

describe('a pinned entity holds its place', () => {
  it('stays where it was when neighbors are added, a new neighbor is put clear of it, and a layout after that leaves it', () => {
    const positions = new Map([['n0', { x: 0, y: 0 }], ['n1', { x: 300, y: 0 }]]);
    const placed = placeNewEntities({ ids: ['n0', 'n1', 'n2', 'n3'], links: [['n0', 'n1'], ['n0', 'n2'], ['n0', 'n3']], positions });
    expect([...placed.keys()].sort()).toEqual(['n2', 'n3']);
    const all = new Map([...positions, ...placed]);
    expect(all.get('n0')).toEqual({ x: 0, y: 0 });
    for (const id of ['n2', 'n3']) {
      const at = all.get(id);
      expect(at !== undefined && Math.abs(at.x) < BOX_WIDTH && Math.abs(at.y) < BOX_HEIGHT, `${id} is clear of the pinned entity`).toBe(false);
    }
    const laid = layoutEntities({ ids: ['n0', 'n1', 'n2', 'n3'], links: [['n0', 'n1'], ['n0', 'n2'], ['n0', 'n3']], positions: all, pinned: new Set(['n0']) });
    expect(laid.has('n0')).toBe(false);
    expect(laid.has('n1')).toBe(true);
  });

  it('is laid out again once it is unpinned', () => {
    const positions = new Map([['n0', { x: 700, y: 700 }], ['n1', { x: 0, y: 0 }], ['n2', { x: 300, y: 0 }]]);
    const input = { ids: ['n0', 'n1', 'n2'], links: [['n0', 'n1'], ['n1', 'n2']] as const, positions };
    expect(layoutEntities({ ...input, links: [...input.links], pinned: new Set(['n0']) }).has('n0')).toBe(false);
    expect(layoutEntities({ ...input, links: [...input.links], pinned: new Set() }).has('n0')).toBe(true);
  });

  it('stays pinned, and where it was, through hide and show and through focus on another entity and leaving it', () => {
    const state = load();
    togglePin(state, [nodeKey('n1')]);
    const at = state.presentation.view.getState().positions.get(nodeKey('n1'));
    state.hide([nodeKey('n1')]);
    expect(state.visibleGraph().nodes.some((node) => elementKey(node.ref) === nodeKey('n1'))).toBe(false);
    state.presentation.showAllHidden();
    expect(state.presentation.view.getState().pins.has(nodeKey('n1'))).toBe(true);
    expect(state.presentation.view.getState().positions.get(nodeKey('n1'))).toEqual(at);
    state.focusOn(nodeKey('n3'));
    state.presentation.leaveFocus();
    expect(state.presentation.view.getState().pins.has(nodeKey('n1'))).toBe(true);
    expect(state.presentation.view.getState().positions.get(nodeKey('n1'))).toEqual(at);
  });

  it('loses its pin when the loaded graph is replaced by one without it', () => {
    const state = load();
    togglePin(state, [nodeKey('n1'), nodeKey('n3')]);
    const rest = ['n0', 'n1', 'n2'];
    state.setLoaded([key('a')], rest.map((id) => ref('a', 'type-a', id)), []);
    expect([...state.presentation.view.getState().pins]).toEqual([nodeKey('n1')]);
  });
});
