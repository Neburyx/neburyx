import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { Scene } from '../canvas/scene.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { edgeKey } from '../state/keys.js';
import { edge, node } from '../state/test-data.js';
import { builtInKeyBindings, clientWith, me, renderApp, source, stubFactory } from '../test-utils.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';
import { registerBuiltInSlots } from './built-in-slots.js';
import { registerBuiltInTools } from './built-in-tools.js';
import { loadGraph, nodeKey } from './context-menu-kit.js';
import { createMenuRegistry } from './menu-registry.js';
import { createSlotRegistry } from './slots.js';
import { createToolRegistry } from './tool-registry.js';

const client = clientWith({ me: me(), sources: [source('a')] });

afterEach(cleanup);

const edgeOf = (id: string) => edgeKey(edge('a', id, 'n1', 'n2').ref);
const everything = [nodeKey('n1'), nodeKey('n2'), nodeKey('n3'), edgeOf('e1'), edgeOf('e2')];

function graph(state: ClientState): void {
  loadGraph(state, [node('a', 'n1'), node('a', 'n2'), node('a', 'n3')], [edge('a', 'e1', 'n1', 'n2'), edge('a', 'e2', 'n2', 'n3'), edge('a', 'e3', 'n1', 'zz')]);
}

async function workspace(state: ClientState = createClientState()) {
  const factory = stubFactory();
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  const menus = createMenuRegistry();
  registerBuiltInMenuItems(menus);
  renderApp('/explore', client, state, slots, factory.create, undefined, tools, menus, undefined, builtInKeyBindings());
  await act(async () => void (await Promise.resolve()));
  const canvas = screen.getByRole('application', { name: 'Graph canvas' });
  const press = (key: string, init: KeyboardEventInit = {}, target: Element = canvas): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => void target.dispatchEvent(event));
    return event;
  };
  const scene = (): Scene | undefined => factory.made[0]?.scenes.at(-1);
  act(() => canvas.focus());
  return { state, canvas, press, scene };
}

const view = (state: ClientState) => state.presentation.view.getState();
const selected = (state: ClientState): string[] => [...view(state).selection].sort();
const status = (): string => screen.getByRole('status').textContent ?? '';

describe('entering the walk', () => {
  it('does nothing with nothing drawn, for Enter and for Space', async () => {
    const { state, press } = await workspace();
    press('Enter');
    press(' ');
    expect(view(state).walking).toBe(false);
    expect(view(state).focused).toBeUndefined();
  });

  it('does nothing for Enter and Space with the focus on the page body or a control, which are not the canvas', async () => {
    const state = createClientState();
    graph(state);
    const { press } = await workspace(state);
    press('Enter', {}, document.body);
    press(' ', {}, screen.getByRole('button', { name: 'Explore' }));
    expect(view(state).walking).toBe(false);
  });

  it.each([['Enter', 'Enter'], ['Space', ' ']])('starts at the first drawn entity on %s and rings it', async (_name, key) => {
    const state = createClientState();
    graph(state);
    const { press, scene } = await workspace(state);
    expect(press(key).defaultPrevented).toBe(true);
    expect(view(state)).toMatchObject({ walking: true, focused: nodeKey('n1') });
    expect(scene()?.focused).toBe(nodeKey('n1'));
  });
});

describe('moving through the walk', () => {
  it('visits the drawn entities then the drawn relationships in their order, wraps both ways, and skips a relationship that is loaded and not drawn', async () => {
    const state = createClientState();
    graph(state);
    const { press } = await workspace(state);
    press('Enter');
    const forward: string[] = [];
    for (let step = 0; step < everything.length; step += 1) {
      press('Tab');
      forward.push(view(state).focused ?? '');
    }
    expect(forward).toEqual([nodeKey('n2'), nodeKey('n3'), edgeOf('e1'), edgeOf('e2'), nodeKey('n1')]);
    const backward: string[] = [];
    for (let step = 0; step < everything.length; step += 1) {
      press('Tab', { shiftKey: true });
      backward.push(view(state).focused ?? '');
    }
    expect(backward).toEqual([edgeOf('e2'), edgeOf('e1'), nodeKey('n3'), nodeKey('n2'), nodeKey('n1')]);
  });

  it('leaves Tab to the browser when the walk is not on', async () => {
    const state = createClientState();
    graph(state);
    const { press } = await workspace(state);
    expect(press('Tab').defaultPrevented).toBe(false);
    expect(press('Tab', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(view(state).walking).toBe(false);
  });
});

describe('selecting from the walk', () => {
  it.each([['Enter', 'Enter'], ['Space', ' ']])('selects the element on %s as a click with the Select tool does, and adds or removes one with Shift', async (_name, key) => {
    const state = createClientState();
    graph(state);
    const { press } = await workspace(state);
    press('Enter');
    press(key);
    expect(selected(state)).toEqual([nodeKey('n1')]);
    press('Tab');
    press(key, { shiftKey: true });
    expect(selected(state)).toEqual([nodeKey('n1'), nodeKey('n2')].sort());
    press(key, { shiftKey: true });
    expect(selected(state)).toEqual([nodeKey('n1')]);
    for (let step = 0; step < 2; step += 1) press('Tab');
    press(key);
    expect(selected(state)).toEqual([edgeOf('e1')]);
  });

  it('selects nothing with the Pan tool', async () => {
    const state = createClientState();
    graph(state);
    state.presentation.setTool('pan');
    const { press } = await workspace(state);
    press('Enter');
    press('Enter');
    press(' ', { shiftKey: true });
    expect(selected(state)).toEqual([]);
  });
});

describe('leaving the walk', () => {
  it('ends it on Esc with the selection kept and the focus on the canvas, remembers the element, and clears the selection on the next Esc', async () => {
    const state = createClientState();
    graph(state);
    const { canvas, press, scene } = await workspace(state);
    press('Enter');
    press('Tab');
    press('Enter');
    press('Escape');
    expect(view(state).walking).toBe(false);
    expect(scene()?.focused).toBeUndefined();
    expect(selected(state)).toEqual([nodeKey('n2')]);
    expect(document.activeElement).toBe(canvas);
    press('Enter');
    expect(view(state).focused).toBe(nodeKey('n2'));
    press('Escape');
    press('Escape');
    expect(selected(state)).toEqual([]);
  });

  it('ends the walk when the canvas loses the focus', async () => {
    const state = createClientState();
    graph(state);
    const { canvas, press } = await workspace(state);
    press('Enter');
    act(() => canvas.blur());
    expect(view(state).walking).toBe(false);
  });

  it('leaves the canvas with Tab in one step after Esc, and never traps it: Tab through every element, then Esc and Tab', async () => {
    const state = createClientState();
    graph(state);
    const { canvas, press } = await workspace(state);
    const user = userEvent.setup();
    press('Enter');
    for (let step = 0; step < everything.length * 2; step += 1) expect(press('Tab').defaultPrevented).toBe(true);
    press('Escape');
    await user.tab();
    expect(document.activeElement).not.toBe(canvas);
    expect(document.activeElement).not.toBe(document.body);
    expect(view(state).walking).toBe(false);
  });
});

describe('an element that goes while the walk is at it', () => {
  it('ends the ring without ending the walk, and the next Tab takes the first element', async () => {
    const state = createClientState();
    graph(state);
    const { press, scene } = await workspace(state);
    press('Enter');
    press('Tab');
    expect(scene()?.focused).toBe(nodeKey('n2'));
    loadGraph(state, [node('a', 'n1'), node('a', 'n3')], []);
    await act(async () => void (await Promise.resolve()));
    expect(scene()?.focused).toBeUndefined();
    expect(view(state)).toMatchObject({ walking: true, focused: undefined });
    press('Tab');
    expect(view(state).focused).toBe(nodeKey('n1'));
  });

  it('forgets an element that is loaded but no longer drawn', async () => {
    const state = createClientState();
    graph(state);
    const { press, scene } = await workspace(state);
    press('Enter');
    press('Tab', { shiftKey: true });
    expect(view(state).focused).toBe(edgeOf('e2'));
    loadGraph(state, [node('a', 'n1'), node('a', 'n2')], [edge('a', 'e2', 'n2', 'n3')]);
    await act(async () => void (await Promise.resolve()));
    expect(scene()?.focused).toBeUndefined();
    expect(view(state).focused).toBeUndefined();
  });
});

describe('what the walk announces', () => {
  it('names an entity by its title and its type, with "pinned" when it is, and a relationship by its label and its two ends, in a polite region', async () => {
    const state = createClientState();
    graph(state);
    state.presentation.pin([nodeKey('n2')]);
    const { press } = await workspace(state);
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(status()).toBe('');
    press('Enter');
    expect(status()).toBe('n1, type-a');
    press('Tab');
    expect(status()).toBe('n2, type-a, pinned');
    for (let step = 0; step < 2; step += 1) press('Tab');
    expect(status()).toBe('rel-a, from n1 to n2');
    press('Escape');
    expect(status()).toBe('');
  });
});

describe('a walk with nothing left to walk to', () => {
  it('is over, and Tab and Shift+Tab are the browser\'s again, so the focus is never held', async () => {
    const state = createClientState();
    graph(state);
    const { press } = await workspace(state);
    press('Enter');
    loadGraph(state, [], []);
    await act(async () => void (await Promise.resolve()));
    expect(view(state).walking).toBe(true);
    expect(press('Tab').defaultPrevented).toBe(false);
    expect(view(state).walking).toBe(false);
    press('Enter');
    expect(view(state).walking).toBe(false);
    expect(press('Tab', { shiftKey: true }).defaultPrevented).toBe(false);
  });
});

