import { act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { edge, node } from '../state/test-data.js';
import { edgeKey } from '../state/keys.js';
import { hideEntities } from '../canvas/hide-commands.js';
import { loadGraph, nodeKey } from './context-menu-kit.js';
import { registerBuiltInKeyBindings } from './built-in-key-bindings.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';
import { createKeyListener } from './key-binding-handler.js';
import { createKeyBindingRegistry } from './key-binding-registry.js';
import { createMenuRegistry, stateOf, type MenuContext, type MenuTargetKind } from './menu-registry.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const link = edgeKey(edge('a', 'e1', 'n1', 'n2').ref);
const [n1, n2, n3, n4] = ['n1', 'n2', 'n3', 'n4'].map(nodeKey) as [string, string, string, string];

function graph(): ClientState {
  const state = createClientState();
  loadGraph(state, [node('a', 'n1'), node('a', 'n2'), node('a', 'n3'), node('a', 'n4')], [edge('a', 'e1', 'n1', 'n2'), edge('a', 'e2', 'n2', 'n3')]);
  return state;
}

const focusOf = (state: ClientState): string | undefined => state.presentation.view.getState().neighborhoodFocus;
const note = (state: ClientState): string | undefined => state.presentation.view.getState().moveNote?.text;

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

function menuItem(state: ClientState, kind: MenuTargetKind, id: string, key: string | undefined) {
  const menus = createMenuRegistry();
  registerBuiltInMenuItems(menus);
  const item = menus.view.getState().get(kind)?.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error('no such item');
  const context: MenuContext = { kind, key, selection: [...state.presentation.view.getState().selection], state, canvas: undefined };
  return { run: () => item.run?.(context), state: () => stateOf(item, context) };
}

describe('Focus neighborhood from the node menu', () => {
  it('puts focus on the entity the menu was opened on, tells a screen reader, and moves focus when opened on another entity', () => {
    const state = graph();
    menuItem(state, 'node', 'focus-neighborhood', n2).run();
    expect(focusOn(state)).toBe(n2);
    expect(note(state)).toBe('Focus on 3 entities. Leave focus from the scope line.');
    menuItem(state, 'node', 'focus-neighborhood', n3).run();
    expect(focusOn(state)).toBe(n3);
    expect(note(state)).toBe('Focus on 2 entities. Leave focus from the scope line.');
  });

  it('is disabled on the focused entity and on an entity that is not drawn', () => {
    const state = graph();
    expect(menuItem(state, 'node', 'focus-neighborhood', n2).state()).toBe('enabled');
    menuItem(state, 'node', 'focus-neighborhood', n2).run();
    expect(menuItem(state, 'node', 'focus-neighborhood', n2).state()).toBe('disabled');
    expect(menuItem(state, 'node', 'focus-neighborhood', n4).state()).toBe('disabled');
    menuItem(state, 'node', 'focus-neighborhood', n4).run();
    expect(focusOn(state)).toBe(n2);
  });

  it('leaves focus from the canvas menu, which is disabled without focus', () => {
    const state = graph();
    expect(menuItem(state, 'canvas', 'leave-focus', undefined).state()).toBe('disabled');
    state.presentation.setViewport({ zoom: 2, x: 1, y: 1 });
    menuItem(state, 'node', 'focus-neighborhood', n2).run();
    state.presentation.setViewport({ zoom: 1, x: 0, y: 0 });
    expect(menuItem(state, 'canvas', 'leave-focus', undefined).state()).toBe('enabled');
    menuItem(state, 'canvas', 'leave-focus', undefined).run();
    expect(focusOf(state)).toBeUndefined();
    expect(state.presentation.view.getState().viewport).toEqual({ zoom: 2, x: 1, y: 1 });
    expect(note(state)).toBe('Focus left.');
  });
});

const focusOn = focusOf;

describe('Focus neighborhood by F', () => {
  it('puts focus on the one selected entity, and F again with nothing or only that entity selected leaves it', () => {
    const state = graph();
    const { press, stop } = keyboard(state);
    state.presentation.select([n2]);
    expect(press('f').defaultPrevented).toBe(true);
    expect(focusOn(state)).toBe(n2);
    expect(press('f').defaultPrevented).toBe(true);
    expect(focusOn(state)).toBeUndefined();
    state.presentation.select([n2]);
    press('f');
    state.presentation.select([]);
    press('f');
    expect(focusOn(state)).toBeUndefined();
    stop();
  });

  it('moves focus to another selected entity', () => {
    const state = graph();
    const { press, stop } = keyboard(state);
    state.presentation.select([n1]);
    press('f');
    state.presentation.select([n2]);
    press('f');
    expect(focusOn(state)).toBe(n2);
    stop();
  });

  it('does nothing and leaves the key to the browser with several selected (focus on and off), a relationship selected, a menu open or a text field', () => {
    const state = graph();
    const { press, stop } = keyboard(state);
    state.presentation.select([n1, n2]);
    expect(press('f').defaultPrevented).toBe(false);
    state.presentation.select([link]);
    expect(press('f').defaultPrevented).toBe(false);
    state.presentation.select([n1]);
    state.presentation.setOpenMenu({ kind: 'node', key: n1, x: 1, y: 1 });
    expect(press('f').defaultPrevented).toBe(false);
    state.presentation.setOpenMenu(undefined);
    const field = document.body.appendChild(document.createElement('input'));
    expect(press('f', field).defaultPrevented).toBe(false);
    expect(focusOn(state)).toBeUndefined();
    press('f');
    expect(focusOn(state)).toBe(n1);
    state.presentation.select([n1, n2]);
    expect(press('f').defaultPrevented).toBe(false);
    expect(focusOn(state)).toBe(n1);
    stop();
  });

  it('lists its key once, as Focus in the selection group', () => {
    const registry = createKeyBindingRegistry('mac');
    registerBuiltInKeyBindings(registry);
    const rows = registry.view.getState().filter((binding) => binding.id === 'focus');
    expect(rows.map((row) => [row.label, row.group, row.shown])).toEqual([['Focus', 'selection', ['F']]]);
  });
});

describe('the other ways focus ends', () => {
  it('ends when the focused entity is hidden, with the viewport back and "Focus left." said', () => {
    const state = graph();
    state.presentation.setViewport({ zoom: 2, x: 1, y: 1 });
    menuItem(state, 'node', 'focus-neighborhood', n2).run();
    hideEntities(state, [n2]);
    expect(focusOf(state)).toBeUndefined();
    expect(state.presentation.view.getState().viewport).toEqual({ zoom: 2, x: 1, y: 1 });
    expect(note(state)).toBe('Hid 1 entity. Show them again from the scope line. Focus left.');
  });

  it('ends when the focused entity is no longer loaded, saying "Focus left."', () => {
    const state = graph();
    menuItem(state, 'node', 'focus-neighborhood', n2).run();
    const held = state.investigation.getState();
    state.setLoaded(held.resultKeys, held.nodeRefs.filter((ref) => ref.stableId !== 'n2'), []);
    expect(focusOf(state)).toBeUndefined();
    expect(note(state)).toBe('Focus left.');
  });

  it('keeps focus when an entity inside it is hidden, and counts it once', () => {
    const state = graph();
    menuItem(state, 'node', 'focus-neighborhood', n2).run();
    hideEntities(state, [n3]);
    expect(focusOf(state)).toBe(n2);
    expect(state.visibleGraph().nodes.map((candidate) => candidate.ref.stableId)).toEqual(['n1', 'n2']);
  });
});
