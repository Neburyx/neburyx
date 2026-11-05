import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { edgeKey } from '../state/keys.js';
import { edge, node } from '../state/test-data.js';
import { builtInKeyBindings, clientWith, me, renderApp, source, stubFactory } from '../test-utils.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';
import { registerBuiltInSlots } from './built-in-slots.js';
import { registerBuiltInTools } from './built-in-tools.js';
import { commandItem, loadGraph, nodeKey } from './context-menu-kit.js';
import { createMenuRegistry } from './menu-registry.js';
import { createSlotRegistry } from './slots.js';
import { createToolRegistry } from './tool-registry.js';

const client = clientWith({ me: me(), sources: [source('a')] });

afterEach(cleanup);

const link = edge('a', 'e1', 'n1', 'n2');

async function workspace(withGraph = true) {
  const state = createClientState();
  if (withGraph) loadGraph(state, [node('a', 'n1'), node('a', 'n2')], [link]);
  const factory = stubFactory();
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  const menus = createMenuRegistry();
  registerBuiltInMenuItems(menus);
  menus.register('node', commandItem('Entity probe'));
  menus.register('relationship', commandItem('Relationship probe'));
  renderApp('/explore', client, state, slots, factory.create, undefined, tools, menus, undefined, builtInKeyBindings());
  await act(async () => void (await Promise.resolve()));
  const canvas = screen.getByRole('application', { name: 'Graph canvas' });
  const press = (key: string, init: KeyboardEventInit = {}, target: Element = canvas): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => void target.dispatchEvent(event));
    return event;
  };
  const rightClick = (target: { readonly kind: 'node' | 'relationship'; readonly key: string } | undefined, x: number, y: number): void => {
    const events = factory.made[0]?.events[0];
    act(() => events?.contextMenu({ target, x, y }));
  };
  act(() => canvas.focus());
  const anchor = (key: string | undefined) => factory.made[0]?.anchorOf(key);
  return { state, canvas, press, rightClick, anchor };
}

const menu = (): HTMLElement => screen.getByRole('menu');
const rows = (): string[] => within(menu()).getAllByRole('menuitem').map((item) => item.querySelector('.menu-label')?.textContent ?? '');
const opened = (state: ClientState) => state.presentation.view.getState().openMenu;
const closeWith = (press: (key: string, init?: KeyboardEventInit, target?: Element) => KeyboardEvent): void => void press('Escape', {}, menu());

describe('opening the context menu from the keyboard', () => {
  it.each([['the menu key', 'ContextMenu', {}], ['Shift+F10', 'F10', { shiftKey: true }]])('does nothing, and leaves the key to the browser, with the focus off the canvas, with %s', async (_name, key, init) => {
    const { state, press } = await workspace();
    expect(press(key, init, document.body).defaultPrevented).toBe(false);
    expect(press(key, init, screen.getByRole('button', { name: 'Explore' })).defaultPrevented).toBe(false);
    expect(opened(state)).toBeUndefined();
  });

  it.each([['the menu key', 'ContextMenu', {}], ['Shift+F10', 'F10', { shiftKey: true }]])('opens the menu of the entity the walk is at, with the items of a right-click on it, at its centre, with %s', async (_name, key, init) => {
    const { state, press, rightClick, anchor } = await workspace();
    press('Enter');
    press('Tab');
    expect(press(key, init).defaultPrevented).toBe(true);
    expect(opened(state)).toEqual({ kind: 'node', key: nodeKey('n2'), ...anchor(nodeKey('n2')) });
    const byKeyboard = rows();
    expect(byKeyboard).toContain('Entity probe');
    expect(screen.getByRole('menu', { name: 'n2' })).toBeTruthy();
    closeWith(press);
    rightClick({ kind: 'node', key: nodeKey('n2') }, 10, 20);
    expect(rows()).toEqual(byKeyboard);
  });

  it('selects an entity that was not selected first, as a right-click does, and keeps the selection when it was selected', async () => {
    const { state, press } = await workspace();
    press('Enter');
    press('ContextMenu');
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n1')]);
    closeWith(press);
    press('Tab');
    state.presentation.select([nodeKey('n1'), nodeKey('n2')]);
    press('ContextMenu');
    expect([...state.presentation.view.getState().selection].sort()).toEqual([nodeKey('n1'), nodeKey('n2')].sort());
  });

  it('opens the menu of the relationship the walk is at, with the items of a right-click on it', async () => {
    const { state, press, rightClick } = await workspace();
    press('Enter');
    press('Tab', { shiftKey: true });
    press('ContextMenu');
    expect(opened(state)).toMatchObject({ kind: 'relationship', key: edgeKey(link.ref), x: 300, y: 350 });
    const byKeyboard = rows();
    expect(byKeyboard).toContain('Relationship probe');
    closeWith(press);
    rightClick({ kind: 'relationship', key: edgeKey(link.ref) }, 300, 350);
    expect(rows()).toEqual(byKeyboard);
  });

  it('opens the canvas menu at the centre of the canvas with the walk off or with no element held, with the items of a right-click on empty canvas', async () => {
    const { state, press, rightClick } = await workspace();
    press('ContextMenu');
    expect(opened(state)).toEqual({ kind: 'canvas', key: undefined, x: 500, y: 400 });
    const byKeyboard = rows();
    closeWith(press);
    rightClick(undefined, 500, 400);
    expect(rows()).toEqual(byKeyboard);
    closeWith(press);
    press('Enter');
    press('Escape');
    press('F10', { shiftKey: true });
    expect(opened(state)).toMatchObject({ kind: 'canvas' });
  });

  it('opens the canvas menu with nothing loaded', async () => {
    const { state, press } = await workspace(false);
    press('ContextMenu');
    expect(opened(state)).toMatchObject({ kind: 'canvas', x: 500, y: 400 });
  });

  it('opens no second menu while one is open, and leaves the key to the browser', async () => {
    const { state, canvas, press } = await workspace();
    press('Enter');
    press('ContextMenu');
    const first = opened(state);
    expect(press('ContextMenu', {}, canvas).defaultPrevented).toBe(false);
    expect(press('F10', { shiftKey: true }, canvas).defaultPrevented).toBe(false);
    expect(opened(state)).toBe(first);
  });

  it('gives the focus back to the canvas when the menu closes on Escape, with the walk still at the element it opened the menu for, ringed throughout', async () => {
    const { state, canvas, press } = await workspace();
    press('Enter');
    press('Tab');
    press('ContextMenu');
    expect(state.presentation.view.getState()).toMatchObject({ walking: true, focused: nodeKey('n2') });
    closeWith(press);
    expect(opened(state)).toBeUndefined();
    expect(document.activeElement).toBe(canvas);
    expect(state.presentation.view.getState()).toMatchObject({ walking: true, focused: nodeKey('n2') });
    press('Tab');
    expect(state.presentation.view.getState().focused).toBe(edgeKey(link.ref));
  });

  it('ends the walk when the menu closes with the focus somewhere else', async () => {
    const { state, press } = await workspace();
    press('Enter');
    press('ContextMenu');
    act(() => screen.getByRole('button', { name: 'Explore' }).focus());
    act(() => state.presentation.setOpenMenu(undefined));
    expect(state.presentation.view.getState().walking).toBe(false);
  });
});
