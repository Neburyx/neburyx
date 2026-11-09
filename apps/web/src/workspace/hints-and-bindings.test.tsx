import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { edge, node } from '../state/test-data.js';
import { createClientState } from '../state/client-state.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { registerStandInKeyBindings, registerStandInMenuItems } from '../dev/stand-ins.js';
import { builtInKeyBindings, clientWith, me, renderApp, source, stubFactory } from '../test-utils.js';
import { registerBuiltInKeyBindings } from './built-in-key-bindings.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';
import { registerBuiltInSlots } from './built-in-slots.js';
import { registerBuiltInTools } from './built-in-tools.js';
import { loadGraph } from './context-menu-kit.js';
import { createKeyBindingRegistry, type KeyBindingEntry, type KeyBindingRegistry } from './key-binding-registry.js';
import { parseKeys } from './key-spec.js';
import { createMenuRegistry, type MenuRegistry, type MenuTargetKind } from './menu-registry.js';
import { createSlotRegistry } from './slots.js';
import { createToolRegistry } from './tool-registry.js';

const client = clientWith({ me: me(), sources: [source('a')] });
const stored = edge('a', 'e-stored', 'n1', 'n2');

afterEach(cleanup);

function everything(keys: KeyBindingRegistry) {
  const state = createClientState();
  loadGraph(state, [node('a', 'n1'), node('a', 'n2')], [stored]);
  const factory = stubFactory();
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  const menus = createMenuRegistry();
  registerBuiltInMenuItems(menus);
  registerStandInMenuItems(menus);
  renderApp('/explore', client, state, slots, factory.create, undefined, tools, menus, undefined, keys);
  return { state, factory, menus };
}

function withStandIns(runs: string[] = []): KeyBindingRegistry {
  const keys = builtInKeyBindings();
  registerStandInKeyBindings(keys, (id) => void runs.push(id));
  return keys;
}

const hintsOf = (menu: HTMLElement): string[] => [...menu.querySelectorAll('.menu-hint')].map((hint) => hint.textContent ?? '');
const shown = (keys: KeyBindingRegistry, id: string): string | undefined => keys.view.getState().find((binding) => binding.id === id)?.shown[0];

/** Every row that names a binding shows that binding's keys as its hint, and every row that names none shows no hint. */
function expectHintsToBeBindings(menu: HTMLElement, kind: MenuTargetKind, menus: MenuRegistry, keys: KeyBindingRegistry): number {
  // the source-record items are hidden here: the page has no profile that gives their types a link
  const items = (menus.view.getState().get(kind) ?? []).filter((item) => item.submenu === undefined && item.id !== 'open-source-record');
  const rows = [...menu.querySelectorAll('[role="menuitem"]')].filter((row) => row.getAttribute('aria-haspopup') === null);
  expect(rows).toHaveLength(items.length);
  let checked = 0;
  rows.forEach((row, index) => {
    const item = items[index];
    if (item === undefined) return;
    const hint = row.querySelector('.menu-hint')?.textContent;
    if (item.binding === undefined) expect(hint, item.id).toBeUndefined();
    else {
      expect(shown(keys, item.binding), `${item.id} names a binding that is not registered`).toBeDefined();
      expect(hint, item.id).toBe(shown(keys, item.binding));
      checked += 1;
    }
  });
  return checked;
}

describe('the hints on the screen are the keys of registered bindings', () => {
  it('holds for the Explore flyout: V, H, B, ⌘A, ⇧⌘I and Esc, each the text of the binding of its row', async () => {
    const keys = withStandIns();
    everything(keys);
    await act(async () => void (await Promise.resolve()));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Explore' }));
    const flyout = screen.getByRole('menu', { name: 'Explore' });
    expect(hintsOf(flyout)).toEqual(['V', 'H', 'B', '⌘A', '⇧⌘I', 'Esc']);
    expect(hintsOf(flyout)).toEqual(['tool-select', 'tool-pan', 'tool-box', 'select-all', 'invert-selection', 'clear-selection'].map((id) => shown(keys, id)));
  });

  it('holds for the canvas menu, the entity menu and the relationship menu, with the development stand-ins', async () => {
    const keys = withStandIns();
    const { factory, menus } = everything(keys);
    await act(async () => void (await Promise.resolve()));
    const open = (request: Parameters<NonNullable<NonNullable<(typeof factory.made)[0]>['events'][0]>['contextMenu']>[0]) => act(() => factory.made[0]?.events[0]?.contextMenu(request));
    open({ target: undefined, x: 10, y: 10 });
    const canvasChecked = expectHintsToBeBindings(screen.getByRole('menu', { name: 'Canvas' }), 'canvas', menus, keys);
    expect(hintsOf(screen.getByRole('menu', { name: 'Canvas' }))).toEqual(['⌘0', '⌘A', '⇧⌘I', 'L', '⌘E']);
    await userEvent.setup().keyboard('{Escape}');
    open({ target: { kind: 'node', key: elementKey(node('a', 'n1').ref) }, x: 10, y: 10 });
    const entityMenu = screen.getAllByRole('menu')[0];
    expect(entityMenu).toBeDefined();
    const nodeChecked = expectHintsToBeBindings(entityMenu ?? document.body, 'node', menus, keys);
    await userEvent.setup().keyboard('{Escape}');
    open({ target: { kind: 'relationship', key: edgeKey(stored.ref) }, x: 10, y: 10 });
    const relationshipMenu = screen.getAllByRole('menu')[0];
    const relationshipChecked = expectHintsToBeBindings(relationshipMenu ?? document.body, 'relationship', menus, keys);
    expect([canvasChecked > 0, nodeChecked > 0, relationshipChecked > 0]).toEqual([true, true, true]);
    expect(hintsOf(relationshipMenu ?? document.body)).not.toContain('↵');
  });

  it('is failed by a hint whose binding is not registered, so a hint that does nothing cannot ship', async () => {
    const keys = withStandIns();
    const { factory, menus } = everything(keys);
    await act(async () => void (await Promise.resolve()));
    act(() => factory.made[0]?.events[0]?.contextMenu({ target: undefined, x: 10, y: 10 }));
    const menu = screen.getByRole('menu', { name: 'Canvas' });
    expect(() => expectHintsToBeBindings(menu, 'canvas', menus, keys)).not.toThrow();
    const without = createKeyBindingRegistry('mac');
    for (const binding of keys.view.getState()) if (binding.id !== 'fit') without.register(binding);
    expect(() => expectHintsToBeBindings(menu, 'canvas', menus, without)).toThrow();
  });
});

describe('pressing the keys of a hint runs its command', () => {
  it('runs the command of every registered binding that has no condition and is not the canvas\'s, built in and stand-in, from its own keys', () => {
    const recorded: KeyBindingEntry[] = [];
    registerBuiltInKeyBindings({ platform: 'mac', view: createKeyBindingRegistry('mac').view, register: (entry) => { recorded.push(entry); return () => undefined; } });
    registerStandInKeyBindings({ platform: 'mac', view: createKeyBindingRegistry('mac').view, register: (entry) => { recorded.push(entry); return () => undefined; } });
    const log: string[] = [];
    const keys = createKeyBindingRegistry('mac');
    const taken = new Set<string>();
    const registered = recorded.filter((entry) => !taken.has(entry.id) && Boolean(taken.add(entry.id)));
    for (const entry of registered) keys.register({ ...entry, run: () => void log.push(entry.id) });
    const state = createClientState();
    renderApp('/explore', client, state, undefined, undefined, undefined, undefined, undefined, undefined, keys);
    const alone = (binding: { readonly when?: unknown; readonly scope: string }): boolean => binding.when === undefined && binding.scope === 'workspace';
    for (const binding of keys.view.getState().filter(alone)) {
      for (const text of binding.keys) {
        const spec = parseKeys(text);
        const key = spec.key === 'delete' ? 'Delete' : spec.shift ? spec.key.toUpperCase() : spec.key;
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, metaKey: spec.mod, shiftKey: spec.shift, altKey: spec.alt }));
      }
    }
    expect(log.sort()).toEqual(registered.filter(alone).map((entry) => entry.id).sort());
    expect(log.length).toBeGreaterThanOrEqual(12);
  });
});

describe('the keys of the walk', () => {
  it('are six bindings of the canvas scope, with the labels and keys the sheet shows, on macOS and elsewhere', () => {
    const rows = (platform: 'mac' | 'other') =>
      builtInKeyBindings(platform)
        .view.getState()
        .filter((binding) => binding.id.startsWith('walk-'))
        .map((binding) => [binding.label, binding.shown.join(' '), binding.scope]);
    expect(rows('mac')).toEqual([
      ['Walk the canvas', 'Enter Space', 'canvas'],
      ['Next element', 'Tab', 'canvas'],
      ['Previous element', '⇧Tab', 'canvas'],
      ['Leave the walk', 'Esc', 'canvas'],
      ['Select the element', 'Enter Space', 'canvas'],
      ['Add to the selection', '⇧Enter ⇧Space', 'canvas'],
    ]);
    expect(rows('other').map((row) => row[1])).toEqual(['Enter Space', 'Tab', 'Shift+Tab', 'Esc', 'Enter Space', 'Shift+Enter Shift+Space']);
  });
});

describe('the key of the context menu', () => {
  it('is one binding of the canvas scope for the menu key and Shift+F10, shown as the sheet shows it', () => {
    const binding = (platform: 'mac' | 'other') => builtInKeyBindings(platform).view.getState().find((candidate) => candidate.id === 'open-context-menu');
    expect(binding('mac')).toMatchObject({ label: 'Open context menu', scope: 'canvas', shown: ['Menu', '⇧F10'] });
    expect(binding('other')?.shown).toEqual(['Menu', 'Shift+F10']);
  });
});

describe('the keys of the arrow move', () => {
  it('are two bindings of the canvas scope for the four arrows and for Shift with them, shown as the sheet shows them, and the keys bound are the keys listed', () => {
    const bindings = (platform: 'mac' | 'other') => builtInKeyBindings(platform).view.getState().filter((binding) => binding.id === 'move' || binding.id === 'move-far');
    expect(bindings('mac').map((binding) => [binding.label, binding.scope, binding.repeat, binding.shown.join(' ')])).toEqual([
      ['Move selected entities', 'canvas', true, '←↑↓→'],
      ['Move by 50', 'canvas', true, '⇧←↑↓→'],
    ]);
    expect(bindings('other').map((binding) => binding.shown.join(' '))).toEqual(['←↑↓→', 'Shift+←↑↓→']);
    expect(bindings('mac').map((binding) => binding.keys)).toEqual([['arrowleft', 'arrowup', 'arrowdown', 'arrowright'], ['shift+arrowleft', 'shift+arrowup', 'shift+arrowdown', 'shift+arrowright']]);
  });
});

describe('the stand-ins for keys that features have built since', () => {
  it('leave a binding that is already there alone, take the keys that are free, and take out only what they put in', () => {
    const registry = createKeyBindingRegistry('mac');
    const own = registry.register({ id: 'search', keys: ['mod+k'], label: 'Search', group: 'tools', order: 10, scope: 'workspace', run: () => undefined });
    const clash = registry.register({ id: 'mine', keys: ['e'], label: 'Mine', group: 'tools', order: 20, scope: 'workspace', run: () => undefined });
    const remove = registerStandInKeyBindings(registry);
    const ids = (): string[] => registry.view.getState().map((binding) => binding.id);
    expect(ids()).toContain('search');
    expect(ids()).toContain('mine');
    expect(ids()).not.toContain('expand');
    expect(ids()).toContain('focus');
    remove();
    expect(ids()).toEqual(['search', 'mine']);
    own();
    clash();
  });
});

describe('the hint of the Search key', () => {
  it('on the sheet is the keys of the one registered Search binding, which has exactly that hint', async () => {
    const keys = builtInKeyBindings('mac');
    everything(keys);
    await screen.findByRole('application', { name: 'Graph canvas' });
    act(() => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true, cancelable: true })));
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    const rows = [...sheet.querySelectorAll('.sheet-row')].filter((row) => row.querySelector('.sheet-label')?.textContent === 'Search');
    const bindings = keys.view.getState().filter((binding) => binding.label === 'Search');
    expect(bindings).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect([...(rows[0]?.querySelectorAll('.sheet-key') ?? [])].map((key) => key.textContent)).toEqual(bindings[0]?.shown);
  });
});
