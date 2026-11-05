import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { edgeKey } from '../state/keys.js';
import { edge, node } from '../state/test-data.js';
import { clientWith, me, renderApp, source, stubFactory } from '../test-utils.js';
import { registerBuiltInKeyBindings } from './built-in-key-bindings.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';
import { registerBuiltInSlots } from './built-in-slots.js';
import { registerBuiltInTools } from './built-in-tools.js';
import { loadGraph, nodeKey } from './context-menu-kit.js';
import { createKeyBindingRegistry } from './key-binding-registry.js';
import { createMenuRegistry } from './menu-registry.js';
import { createSlotRegistry } from './slots.js';
import { createToolRegistry } from './tool-registry.js';

const client = clientWith({ me: me(), sources: [source('a')] });

afterEach(cleanup);

const link = edge('a', 'e1', 'n1', 'n2');

async function workspace() {
  const state = createClientState();
  loadGraph(state, [node('a', 'n1'), node('a', 'n2'), node('a', 'n3')], [link]);
  const frames: Array<() => void> = [];
  const keys = createKeyBindingRegistry('mac');
  registerBuiltInKeyBindings(keys, (callback) => void frames.push(callback));
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  const menus = createMenuRegistry();
  registerBuiltInMenuItems(menus);
  renderApp('/explore', client, state, slots, stubFactory().create, undefined, tools, menus, undefined, keys);
  await act(async () => void (await Promise.resolve()));
  const canvas = screen.getByRole('application', { name: 'Graph canvas' });
  const press = (key: string, init: KeyboardEventInit = {}, target: Element = canvas): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => void target.dispatchEvent(event));
    return event;
  };
  const frame = (): void => {
    const due = frames.splice(0);
    act(() => due.forEach((callback) => callback()));
  };
  act(() => canvas.focus());
  const writes = vi.spyOn(state.presentation, 'setPositions');
  return { state, canvas, press, frame, writes, scheduled: () => frames.length };
}

const where = (state: ClientState, id: string) => state.presentation.view.getState().positions.get(nodeKey(id));
const status = (): string => screen.getByRole('status').textContent ?? '';
const select = (state: ClientState, ...ids: string[]): void => act(() => state.presentation.select(ids.map(nodeKey)));

describe('the arrow keys that do not move anything', () => {
  it('leave the key to the browser with nothing selected, with only a relationship selected, and with the Pan tool', async () => {
    const { state, press, frame, writes, scheduled } = await workspace();
    expect(press('ArrowLeft').defaultPrevented).toBe(false);
    act(() => state.presentation.select([edgeKey(link.ref)]));
    expect(press('ArrowLeft').defaultPrevented).toBe(false);
    select(state, 'n1');
    act(() => state.presentation.setTool('pan'));
    expect(press('ArrowLeft').defaultPrevented).toBe(false);
    frame();
    expect(scheduled()).toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });

  it('do nothing with the focus on the page body, a control or a text field', async () => {
    const { state, press, frame, writes } = await workspace();
    select(state, 'n1');
    const before = where(state, 'n1');
    const input = document.createElement('input');
    document.body.append(input);
    for (const target of [document.body, screen.getByRole('button', { name: 'Explore' }), input]) expect(press('ArrowRight', {}, target).defaultPrevented).toBe(false);
    frame();
    expect(where(state, 'n1')).toEqual(before);
    expect(writes).not.toHaveBeenCalled();
    input.remove();
  });
});

describe('moving the selected entities with the arrow keys', () => {
  it('moves each selected entity by 10 for an arrow and by 50 with Shift, up being −y, and leaves the others', async () => {
    const { state, press, frame } = await workspace();
    select(state, 'n1', 'n2');
    const [n1, n2, n3] = ['n1', 'n2', 'n3'].map((id) => where(state, id));
    for (const [key, shift, dx, dy] of [['ArrowLeft', false, -10, 0], ['ArrowRight', false, 10, 0], ['ArrowUp', false, 0, -10], ['ArrowDown', false, 0, 10], ['ArrowLeft', true, -50, 0], ['ArrowDown', true, 0, 50]] as const) {
      const before = [where(state, 'n1'), where(state, 'n2')];
      expect(press(key, { shiftKey: shift }).defaultPrevented).toBe(true);
      frame();
      expect([where(state, 'n1'), where(state, 'n2')], `${key} ${shift}`).toEqual(before.map((at) => ({ x: (at?.x ?? 0) + dx, y: (at?.y ?? 0) + dy })));
    }
    expect(where(state, 'n3')).toEqual(n3);
    expect(n1).toBeDefined();
    expect(n2).toBeDefined();
  });

  it('stores all the moved entities in one update, for a press and for the presses of one frame, and says what moved', async () => {
    const { state, press, frame, writes } = await workspace();
    select(state, 'n1', 'n2');
    const start = where(state, 'n1');
    press('ArrowRight');
    frame();
    expect(writes).toHaveBeenCalledTimes(1);
    expect([...(writes.mock.calls[0]?.[0].keys() ?? [])].sort()).toEqual([nodeKey('n1'), nodeKey('n2')].sort());
    expect(status()).toBe('2 entities moved');
    for (let held = 0; held < 4; held += 1) press('ArrowDown', { repeat: held > 0 });
    expect(writes).toHaveBeenCalledTimes(1);
    frame();
    expect(writes).toHaveBeenCalledTimes(2);
    expect(where(state, 'n1')).toEqual({ x: (start?.x ?? 0) + 10, y: (start?.y ?? 0) + 40 });
    press('ArrowUp');
    frame();
    expect(writes).toHaveBeenCalledTimes(3);
  });

  it('keeps a pinned entity where it is and writes nothing for it, moves the others, and says how many stayed', async () => {
    const { state, press, frame, writes } = await workspace();
    act(() => state.presentation.pin([nodeKey('n2')]));
    select(state, 'n1', 'n2');
    const pinned = where(state, 'n2');
    const start = where(state, 'n1');
    press('ArrowLeft');
    frame();
    expect(where(state, 'n2')).toEqual(pinned);
    expect(where(state, 'n1')).toEqual({ x: (start?.x ?? 0) - 10, y: start?.y ?? 0 });
    expect([...(writes.mock.calls[0]?.[0].keys() ?? [])]).toEqual([nodeKey('n1')]);
    expect(status()).toBe('1 entity moved, 1 pinned stayed');
  });

  it('says that none moved when every selected entity is pinned, without writing, and still keeps the key', async () => {
    const { state, press, frame, writes } = await workspace();
    act(() => state.presentation.pin([nodeKey('n1')]));
    select(state, 'n1');
    expect(press('ArrowLeft').defaultPrevented).toBe(true);
    frame();
    expect(writes).not.toHaveBeenCalled();
    expect(status()).toBe('0 entities moved, 1 pinned stayed');
  });

  it('works in the Box select tool, and goes quiet when the focus leaves the canvas or the selection changes', async () => {
    const { state, canvas, press, frame } = await workspace();
    act(() => state.presentation.setTool('box'));
    select(state, 'n1');
    press('ArrowUp');
    frame();
    expect(status()).toBe('1 entity moved');
    select(state, 'n2');
    expect(status()).toBe('');
    press('ArrowUp');
    frame();
    act(() => canvas.blur());
    expect(status()).toBe('');
  });

  it('does not throw when a selected entity goes before the frame, and moves the others', async () => {
    const { state, press, frame } = await workspace();
    select(state, 'n1', 'n2');
    const start = where(state, 'n1');
    press('ArrowRight');
    loadGraph(state, [node('a', 'n1'), node('a', 'n3')], []);
    expect(() => frame()).not.toThrow();
    expect(where(state, 'n1')).toEqual({ x: (start?.x ?? 0) + 10, y: start?.y ?? 0 });
    expect(status()).toBe('1 entity moved');
  });

  it('makes the whole frame one store update, the positions and the announcement together', async () => {
    const { state, press, frame } = await workspace();
    select(state, 'n1', 'n2');
    press('ArrowRight');
    const heard = vi.fn();
    const stop = state.presentation.view.subscribe(heard);
    frame();
    stop();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(status()).toBe('2 entities moved');
  });

  it('announces each move that is a new press even when the words are the same, and a key held down once', async () => {
    const { state, press, frame } = await workspace();
    select(state, 'n1');
    const serial = (): number | undefined => state.presentation.view.getState().moveNote?.serial;
    press('ArrowRight');
    frame();
    const first = serial();
    press('ArrowRight');
    frame();
    expect(serial()).toBe((first ?? 0) + 1);
    expect(status()).toBe('1 entity moved');
    press('ArrowRight', { repeat: true });
    frame();
    press('ArrowRight', { repeat: true });
    frame();
    expect(serial()).toBe((first ?? 0) + 1);
    press('ArrowLeft');
    frame();
    expect(serial()).toBe((first ?? 0) + 2);
  });
});

