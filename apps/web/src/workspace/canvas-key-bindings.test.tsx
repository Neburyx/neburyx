import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { builtInKeyBindings, clientWith, me, renderApp, source, stubFactory } from '../test-utils.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';
import { registerBuiltInSlots } from './built-in-slots.js';
import { registerBuiltInTools } from './built-in-tools.js';
import { load, nodeKey } from './context-menu-kit.js';
import { createMenuRegistry } from './menu-registry.js';
import { createSlotRegistry } from './slots.js';
import { createToolRegistry } from './tool-registry.js';

const client = clientWith({ me: me(), sources: [source('a')] });

afterEach(cleanup);

function workspace(state: ClientState = createClientState(), keys = builtInKeyBindings()) {
  const factory = stubFactory();
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  const menus = createMenuRegistry();
  registerBuiltInMenuItems(menus);
  const rendered = renderApp('/explore', client, state, slots, factory.create, undefined, tools, menus, undefined, keys);
  return { ...rendered, state, factory };
}

const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => void target.dispatchEvent(event));
  return event;
};

const tool = (state: ClientState) => state.presentation.view.getState().tool;
const selected = (state: ClientState): string[] => [...state.presentation.view.getState().selection].sort();
const everyone = ['n1', 'n2', 'n3'].map(nodeKey).sort();

describe('the tool keys', () => {
  it('make V, H and B the Select, Pan and Box select tool, as the rows of the flyout do, and the flyout shows the new tool checked', async () => {
    const state = createClientState();
    load(state);
    workspace(state);
    await act(async () => void (await Promise.resolve()));
    const iconBefore = screen.getByRole('button', { name: 'Explore' }).innerHTML;
    press('h');
    expect(tool(state)).toBe('pan');
    press('b');
    expect(tool(state)).toBe('box');
    press('v');
    expect(tool(state)).toBe('select');
    press('h');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Explore' }));
    expect(screen.getByRole('menuitemradio', { name: 'Pan' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: 'Explore' }).innerHTML).toBe(iconBefore);
  });
});

describe('the selection keys', () => {
  it('select every entity with ⌘A and invert the selection with ⇧⌘I, as the flyout and the canvas menu do', async () => {
    const state = createClientState();
    load(state);
    workspace(state);
    await act(async () => void (await Promise.resolve()));
    press('a', { metaKey: true });
    expect(selected(state)).toEqual(everyone);
    act(() => state.presentation.select([nodeKey('n1')]));
    press('I', { metaKey: true, shiftKey: true });
    expect(selected(state)).toEqual([nodeKey('n2'), nodeKey('n3')].sort());
  });

  it('do nothing and throw nothing when no graph is loaded', async () => {
    const state = createClientState();
    workspace(state);
    await act(async () => void (await Promise.resolve()));
    expect(() => {
      press('a', { metaKey: true });
      press('I', { metaKey: true, shiftKey: true });
    }).not.toThrow();
    expect(selected(state)).toEqual([]);
  });

  it('clear the selection with Esc from the page body, a control and the canvas, and do nothing with an empty selection', async () => {
    const state = createClientState();
    load(state);
    const { container } = workspace(state);
    await act(async () => void (await Promise.resolve()));
    act(() => state.presentation.select([nodeKey('n1'), nodeKey('n2')]));
    press('Escape');
    expect(selected(state)).toEqual([]);
    act(() => state.presentation.select([nodeKey('n1')]));
    press('Escape', {}, screen.getByRole('button', { name: 'Explore' }));
    expect(selected(state)).toEqual([]);
    act(() => state.presentation.select([nodeKey('n3')]));
    press('Escape', {}, container.querySelector('.graph-canvas') ?? document.body);
    expect(selected(state)).toEqual([]);
    expect(() => press('Escape')).not.toThrow();
  });
});

describe('Esc belongs to what holds the focus', () => {
  it('closes a tool-strip flyout, puts the focus on its button and leaves the selection when the flyout holds the focus', async () => {
    const state = createClientState();
    load(state);
    workspace(state);
    await act(async () => void (await Promise.resolve()));
    act(() => state.presentation.select([nodeKey('n1')]));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Explore' }));
    expect(screen.getByRole('menu', { name: 'Explore' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Explore' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Explore' }));
    expect(selected(state)).toEqual([nodeKey('n1')]);
  });

  it('closes the layout popup of the zoom controls and leaves the selection when it holds the focus', async () => {
    const state = createClientState();
    load(state);
    workspace(state);
    await act(async () => void (await Promise.resolve()));
    act(() => state.presentation.select([nodeKey('n1')]));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Layout: Force' }));
    expect(screen.getByRole('menuitemradio', { name: 'Force' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menuitemradio', { name: 'Force' })).toBeNull();
    expect(selected(state)).toEqual([nodeKey('n1')]);
  });

  it('closes a context menu, then lets the next Esc clear the selection', async () => {
    const state = createClientState();
    load(state);
    const { factory } = workspace(state);
    await act(async () => void (await Promise.resolve()));
    act(() => state.presentation.select([nodeKey('n1'), nodeKey('n2')]));
    act(() => factory.made[0]?.events[0]?.contextMenu({ target: undefined, x: 10, y: 10 }));
    expect(screen.getByRole('menu', { name: 'Canvas' })).toBeTruthy();
    await userEvent.setup().keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Canvas' })).toBeNull();
    expect(selected(state)).toEqual([nodeKey('n1'), nodeKey('n2')].sort());
    press('Escape');
    expect(selected(state)).toEqual([]);
  });

  it('runs none of the tool, selection and legend keys while a context menu holds the focus', async () => {
    const state = createClientState();
    load(state);
    const { factory } = workspace(state);
    await act(async () => void (await Promise.resolve()));
    act(() => factory.made[0]?.events[0]?.contextMenu({ target: undefined, x: 10, y: 10 }));
    const menu = screen.getByRole('menu', { name: 'Canvas' });
    const inside = menu.querySelector('[role="menuitem"]');
    expect(inside).not.toBeNull();
    for (const [key, init] of [['h', {}], ['b', {}], ['l', {}], ['a', { metaKey: true }]] as const) press(key, init, inside ?? menu);
    expect(tool(state)).toBe('select');
    expect(state.presentation.view.getState().legendOpen).toBe(false);
    expect(selected(state)).toEqual([]);
  });
});

describe('the legend key', () => {
  it('opens the legend and closes it on the next press, as the strip and the canvas menu do', async () => {
    const state = createClientState();
    workspace(state);
    await act(async () => void (await Promise.resolve()));
    press('l');
    expect(state.presentation.view.getState().legendOpen).toBe(true);
    expect(screen.getByRole('button', { name: 'Legend' }).getAttribute('aria-expanded')).toBe('true');
    press('l');
    expect(state.presentation.view.getState().legendOpen).toBe(false);
  });
});

