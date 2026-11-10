import { act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { togglePin } from '../canvas/pin-commands.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { edge, key, node, ref } from '../state/test-data.js';
import { loadGraph, nodeKey } from './context-menu-kit.js';
import { registerBuiltInKeyBindings } from './built-in-key-bindings.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';
import { createKeyListener } from './key-binding-handler.js';
import { createKeyBindingRegistry } from './key-binding-registry.js';
import { createMenuRegistry, stateOf, type MenuContext } from './menu-registry.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const link = edgeKey(edge('a', 'e1', 'n1', 'n2').ref);

function graph(): ClientState {
  const state = createClientState();
  loadGraph(state, [node('a', 'n1'), node('a', 'n2'), node('a', 'n3'), node('a', 'n4')], [edge('a', 'e1', 'n1', 'n2')]);
  return state;
}

const pinned = (state: ClientState): string[] => [...state.presentation.view.getState().pins].sort();
const said = (state: ClientState): string | undefined => state.presentation.view.getState().moveNote?.text;

function keyboard(state: ClientState) {
  const registry = createKeyBindingRegistry('mac');
  registerBuiltInKeyBindings(registry);
  const listener = createKeyListener(registry, () => ({ state, canvas: undefined }));
  document.addEventListener('keydown', listener);
  const press = (key: string, target: Element = document.body): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    act(() => void target.dispatchEvent(event));
    return event;
  };
  return { registry, press, stop: () => document.removeEventListener('keydown', listener) };
}

function pinItem(state: ClientState, key: string | undefined = nodeKey('n1')) {
  const menus = createMenuRegistry();
  registerBuiltInMenuItems(menus);
  const item = menus.view.getState().get('node')?.find((candidate) => candidate.id === 'pin-position');
  if (item === undefined || item.run === undefined) throw new Error('no such item');
  const context: MenuContext = { kind: 'node', key, selection: [...state.presentation.view.getState().selection], state, canvas: undefined };
  return { label: () => (typeof item.label === 'function' ? item.label(context) : item.label), state: () => stateOf(item, context), run: () => item.run?.(context) };
}

describe('Pin position from the node menu', () => {
  it('pins the entity, then reads "Unpin position" and releases it without moving it', () => {
    const state = graph();
    state.presentation.setPosition(nodeKey('n1'), { x: 10, y: 20 });
    expect(pinItem(state).label()).toBe('Pin position');
    pinItem(state).run();
    expect(pinned(state)).toEqual([nodeKey('n1')]);
    expect(said(state)).toBe('Pinned 1 entity.');
    expect(pinItem(state).label()).toBe('Unpin position');
    pinItem(state).run();
    expect(pinned(state)).toEqual([]);
    expect(said(state)).toBe('Unpinned 1 entity.');
    expect(state.presentation.view.getState().positions.get(nodeKey('n1'))).toEqual({ x: 10, y: 20 });
  });

  it('acts on the whole selection when opened on a selected entity, and on the entity alone otherwise', () => {
    const state = graph();
    state.presentation.select([nodeKey('n1'), nodeKey('n2')]);
    pinItem(state, nodeKey('n2')).run();
    expect(pinned(state)).toEqual([nodeKey('n1'), nodeKey('n2')]);
    expect(said(state)).toBe('Pinned 2 entities.');
    pinItem(state, nodeKey('n3')).run();
    expect(pinned(state)).toEqual([nodeKey('n1'), nodeKey('n2'), nodeKey('n3')]);
  });

  it('pins the rest of a mixed selection, reads "Pin position", and counts only what changed', () => {
    const state = graph();
    state.presentation.pin([nodeKey('n1')]);
    state.presentation.select([nodeKey('n1'), nodeKey('n2')]);
    expect(pinItem(state).label()).toBe('Pin position');
    pinItem(state).run();
    expect(pinned(state)).toEqual([nodeKey('n1'), nodeKey('n2')]);
    expect(said(state)).toBe('Pinned 1 entity.');
  });

  it('is disabled and does nothing for an entity that is not drawn, and leaves selection and walk element alone', () => {
    const state = graph();
    state.hide([nodeKey('n3')]);
    expect(pinItem(state, nodeKey('n3')).state()).toBe('disabled');
    pinItem(state, nodeKey('n3')).run();
    expect(pinned(state)).toEqual([]);
    state.presentation.select([nodeKey('n1')]);
    const before = state.presentation.view.getState();
    pinItem(state).run();
    const after = state.presentation.view.getState();
    expect([...after.selection]).toEqual([...before.selection]);
    expect(after.focused).toBe(before.focused);
    expect(after.viewport).toBe(before.viewport);
  });
});

describe('Pin position by the P key', () => {
  it('pins the selected entities, unpins them when all are pinned, and ignores the relationship in a mixed selection', () => {
    const state = graph();
    const { press, stop } = keyboard(state);
    state.presentation.select([nodeKey('n1'), nodeKey('n3'), link]);
    expect(press('p').defaultPrevented).toBe(true);
    expect(pinned(state)).toEqual([nodeKey('n1'), nodeKey('n3')]);
    expect(said(state)).toBe('Pinned 2 entities.');
    press('p');
    expect(pinned(state)).toEqual([]);
    expect(said(state)).toBe('Unpinned 2 entities.');
    stop();
  });

  it('does nothing with nothing selected, with only a relationship selected, with a menu open, or from a text field', () => {
    const state = graph();
    const { press, stop } = keyboard(state);
    press('p');
    state.presentation.select([link]);
    press('p');
    state.presentation.select([nodeKey('n1')]);
    state.presentation.setOpenMenu({ kind: 'node', key: nodeKey('n1'), x: 0, y: 0 });
    press('p');
    state.presentation.setOpenMenu(undefined);
    const field = document.body.appendChild(document.createElement('input'));
    press('p', field);
    expect(pinned(state)).toEqual([]);
    stop();
  });

  it('lists "Pin position P" under Actions once, beside Hide', () => {
    const registry = createKeyBindingRegistry('mac');
    registerBuiltInKeyBindings(registry);
    const labels = [...registry.view.getState()].filter((binding) => binding.group === 'actions').map((binding) => binding.label);
    expect(labels).toEqual(['Pin position', 'Hide']);
  });
});

describe('the command', () => {
  it('ignores relationships and entities that are not drawn and says nothing when nothing changes', () => {
    const state = graph();
    state.hide([nodeKey('n4')]);
    togglePin(state, [link, nodeKey('n4')]);
    expect(pinned(state)).toEqual([]);
    expect(said(state)).toBeUndefined();
  });

  it('keeps pins when the investigation is set aside and resumed', () => {
    const state = createClientState();
    const record = { title: 't', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' } } as const;
    const refs = ['n1', 'n2'].map((id) => ref('a', 'type-a', id));
    const first = { id: 'i1', sourceId: 'a', record, resultKeys: [key('a')], nodeRefs: refs, edgeRefs: [] };
    const second = { id: 'i2', sourceId: 'a', record, resultKeys: [key('a', 'seed-2')], nodeRefs: [refs[0] as (typeof refs)[number]], edgeRefs: [] };
    state.bindSource('a');
    state.show(first, [{ key: key('a'), result: { sourceId: 'a', nodes: [node('a', 'n1'), node('a', 'n2')], edges: [] } }]);
    togglePin(state, [nodeKey('n1'), nodeKey('n2')]);
    state.show(second, [{ key: key('a', 'seed-2'), result: { sourceId: 'a', nodes: [node('a', 'n1')], edges: [] } }]);
    expect(pinned(state)).toEqual([]);
    expect(state.show(first, [{ key: key('a'), result: { sourceId: 'a', nodes: [node('a', 'n1'), node('a', 'n2')], edges: [] } }])).toBe('resumed');
    expect(pinned(state)).toEqual([nodeKey('n1'), nodeKey('n2')]);
  });
});

describe('what is not drawn is not a target', () => {
  const typedGraph = (): ClientState => {
    const state = createClientState();
    const nodes = [{ ...node('a', 'n1'), ref: ref('a', 'kind-a', 'n1') }, { ...node('a', 'n2'), ref: ref('a', 'kind-a', 'n2') }, { ...node('a', 'n3'), ref: ref('a', 'kind-b', 'n3') }];
    const edges = [{ ...edge('a', 'e1', 'n1', 'n2'), from: ref('a', 'kind-a', 'n1'), to: ref('a', 'kind-a', 'n2') }];
    state.bindSource('a');
    state.putResult(key('a'), { sourceId: 'a', nodes, edges });
    state.setLoaded([key('a')], nodes.map((candidate) => candidate.ref), edges.map((candidate) => candidate.ref));
    state.presentation.setMappedTypes({ entityTypes: ['kind-a', 'kind-b'], relationshipTypes: [] });
    return state;
  };
  const keyOf = (id: string, type: string): string => elementKey(ref('a', type, id));

  it('ignores an entity whose type is filtered off, by the key, the menu and the command', () => {
    const state = typedGraph();
    state.setEntityTypeOff('kind-b', true);
    const off = keyOf('n3', 'kind-b');
    state.presentation.select([off]);
    const { press, stop } = keyboard(state);
    press('p');
    stop();
    expect(pinned(state)).toEqual([]);
    const menus = createMenuRegistry();
    registerBuiltInMenuItems(menus);
    const item = menus.view.getState().get('node')?.find((candidate) => candidate.id === 'pin-position');
    const context: MenuContext = { kind: 'node', key: off, selection: [], state, canvas: undefined };
    expect(item === undefined ? undefined : stateOf(item, context)).toBe('disabled');
    togglePin(state, [off]);
    expect(pinned(state)).toEqual([]);
  });

  it('ignores an entity that focus sets aside, by the key, the menu and the command', () => {
    const state = graph();
    state.focusOn(nodeKey('n1'));
    state.presentation.select([nodeKey('n4')]);
    const { press, stop } = keyboard(state);
    press('p');
    stop();
    expect(pinned(state)).toEqual([]);
    expect(pinItem(state, nodeKey('n4')).state()).toBe('disabled');
    togglePin(state, [nodeKey('n4')]);
    expect(pinned(state)).toEqual([]);
  });
});

describe('the walk and the key', () => {
  it('leaves the walk on the entity it was on when P pins it, and works from a button too', () => {
    const state = graph();
    state.presentation.select([nodeKey('n1')]);
    state.presentation.walkTo(nodeKey('n1'));
    const { press, stop } = keyboard(state);
    const region = document.body.appendChild(document.createElement('div'));
    region.setAttribute('data-key-scope', 'workspace');
    const button = region.appendChild(document.createElement('button'));
    press('p', button);
    stop();
    const now = state.presentation.view.getState();
    expect(now.pins.has(nodeKey('n1'))).toBe(true);
    expect([now.walking, now.focused]).toEqual([true, nodeKey('n1')]);
  });

  it('gives the menu, the key and the bar one result and one announcement for one state', async () => {
    const results: string[][] = [];
    for (const how of ['menu', 'key', 'bar'] as const) {
      cleanup();
      const state = graph();
      state.presentation.pin([nodeKey('n1')]);
      state.presentation.select([nodeKey('n1'), nodeKey('n2'), link]);
      if (how === 'menu') pinItem(state, nodeKey('n2')).run();
      if (how === 'key') {
        const { press, stop } = keyboard(state);
        press('p');
        stop();
      }
      if (how === 'bar') togglePin(state, [...state.presentation.view.getState().selection]); // what the bar's button runs: its own click is in pin-selection-bar.test.tsx
      results.push([...pinned(state), '|', said(state) ?? '']);
    }
    expect(results[0]).toEqual([nodeKey('n1'), nodeKey('n2'), '|', 'Pinned 1 entity.']);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });
});
