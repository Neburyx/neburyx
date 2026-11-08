import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { registerStandInKeyBindings } from '../dev/stand-ins.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { builtInKeyBindings, clientWith, me, renderApp, source, stubFactory } from '../test-utils.js';
import { registerBuiltInSlots } from './built-in-slots.js';
import { registerBuiltInTools } from './built-in-tools.js';
import { load, nodeKey } from './context-menu-kit.js';
import { createKeyBindingRegistry, KeyBindingsProvider, type KeyBindingRegistry } from './key-binding-registry.js';
import { SHEET_FOOTNOTE, ShortcutSheet } from './shortcut-sheet.js';
import { createSlotRegistry } from './slots.js';
import { createToolRegistry } from './tool-registry.js';

const client = clientWith({ me: me(), sources: [source('a')] });

afterEach(cleanup);

function workspace(keys: KeyBindingRegistry, state: ClientState = createClientState()) {
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  renderApp('/explore', client, state, slots, stubFactory().create, undefined, tools, undefined, undefined, keys);
  return state;
}

const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body): void => {
  act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })));
};
const opener = (): void => press('/', { metaKey: true });
const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
const columns = (): Record<string, string[]> =>
  Object.fromEntries(
    [...dialog().querySelectorAll('section')].map((section) => [
      section.getAttribute('aria-label') ?? '',
      [...section.querySelectorAll('.sheet-row')].map((row) => `${row.querySelector('.sheet-label')?.textContent} ${[...row.querySelectorAll('.sheet-key')].map((key) => key.textContent).join(' ')}`),
    ]),
  );

describe('the sheet of keyboard shortcuts', () => {
  it('opens on ⌘/ with the focus inside it, names itself, shows the footnote, and lists exactly the registered bindings by group in their order', async () => {
    const keys = builtInKeyBindings();
    workspace(keys);
    await act(async () => void (await Promise.resolve()));
    expect(screen.queryByRole('dialog')).toBeNull();
    opener();
    expect(dialog().contains(document.activeElement)).toBe(true);
    expect(screen.getByText(SHEET_FOOTNOTE)).toBeTruthy();
    expect(columns()).toEqual({
      TOOLS: ['Select V', 'Pan H', 'Box select B', 'Search ⌘K', 'Legend L'],
      SELECTION: ['Select all ⌘A', 'Invert selection ⇧⌘I', 'Clear Esc', 'Expand E', 'Move selected entities ←↑↓→', 'Move by 50 ⇧←↑↓→', 'Select the element Enter Space', 'Add to the selection ⇧Enter ⇧Space'],
      ACTIONS: ['Hide ⌫'],
      VIEW: ['Fit to view ⌘0', 'Keyboard shortcuts ⌘/', 'Walk the canvas Enter Space', 'Next element Tab', 'Previous element ⇧Tab', 'Leave the walk Esc', 'Open context menu Menu ⇧F10'],
    });
  });

  it('closes on ⌘/ again, on Esc and on the close button, without clearing the selection, and gives the focus back to the control that had it', async () => {
    const state = createClientState();
    load(state);
    workspace(builtInKeyBindings(), state);
    await act(async () => void (await Promise.resolve()));
    act(() => state.presentation.select([nodeKey('n1')]));
    const explore = screen.getByRole('button', { name: 'Explore' });
    explore.focus();
    opener();
    press('/', { metaKey: true }, dialog());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(explore);
    opener();
    press('Escape', {}, dialog());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n1')]);
    expect(document.activeElement).toBe(explore);
    opener();
    await userEvent.setup().click(within(dialog()).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('follows a binding registered or removed while it is open, with no stale row', async () => {
    const keys = builtInKeyBindings();
    workspace(keys);
    await act(async () => void (await Promise.resolve()));
    opener();
    let remove = (): void => undefined;
    act(() => {
      remove = keys.register({ id: 'extra', keys: ['x'], label: 'Extra', group: 'actions', order: 10, scope: 'workspace', run: () => undefined });
    });
    expect(columns()['ACTIONS']).toEqual(['Extra X', 'Hide ⌫']);
    act(() => remove());
    expect(columns()['ACTIONS']).toEqual(['Hide ⌫']);
  });

  it('keeps the Tab key inside, makes the page behind inert, runs no other binding, and takes the inert mark off when it closes', async () => {
    const state = createClientState();
    load(state);
    workspace(builtInKeyBindings(), state);
    await act(async () => void (await Promise.resolve()));
    opener();
    const behind = document.querySelector('[data-key-scope="workspace"]');
    expect(behind?.hasAttribute('inert')).toBe(true);
    for (const [key, init] of [['h', {}], ['b', {}], ['l', {}], ['a', { metaKey: true }]] as const) press(key, init, dialog());
    expect(state.presentation.view.getState().tool).toBe('select');
    expect(state.presentation.view.getState().legendOpen).toBe(false);
    expect([...state.presentation.view.getState().selection]).toEqual([]);
    const close = within(dialog()).getByRole('button', { name: 'Close' });
    close.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => void close.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(close);
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    act(() => void close.dispatchEvent(back));
    expect(document.activeElement).toBe(close);
    press('Escape', {}, dialog());
    expect(behind?.hasAttribute('inert')).toBe(false);
  });

  it('shows the three groups of the design with the stand-ins for the keys no feature has, in the design\'s order, the rows the design does not have after them, and each stand-in works from the keyboard', async () => {
    const keys = builtInKeyBindings();
    const log: string[] = [];
    const removeStandIns = registerStandInKeyBindings(keys, (id) => void log.push(id));
    workspace(keys);
    await act(async () => void (await Promise.resolve()));
    opener();
    expect(columns()).toEqual({
      TOOLS: ['Select V', 'Pan H', 'Box select B', 'Search ⌘K', 'Legend L'],
      SELECTION: ['Select all ⌘A', 'Invert selection ⇧⌘I', 'Clear Esc', 'Expand E', 'Focus F', 'Move selected entities ←↑↓→', 'Move by 50 ⇧←↑↓→', 'Select the element Enter Space', 'Add to the selection ⇧Enter ⇧Space'],
      ACTIONS: ['Pin position P', 'Hide ⌫', 'Copy ID ⌘C', 'Find paths ⇧P', 'Export view ⌘E', 'Copy properties ⇧⌘C'],
      VIEW: ['Fit to view ⌘0', 'Keyboard shortcuts ⌘/', 'Walk the canvas Enter Space', 'Next element Tab', 'Previous element ⇧Tab', 'Leave the walk Esc', 'Open context menu Menu ⇧F10'],
    });
    press('Escape', {}, dialog());
    press('e');
    press('f');
    press('p');
    press('P', { shiftKey: true });
    press('k', { metaKey: true });
    press('c', { metaKey: true });
    press('e', { metaKey: true });
    press('C', { metaKey: true, shiftKey: true });
    expect(log.sort()).toEqual(['copy-id', 'copy-properties', 'export-view', 'find-paths', 'focus', 'pin', 'search']);
    act(() => removeStandIns());
    opener();
    expect(columns()['ACTIONS']).toEqual(['Hide ⌫']);
  });

  it('lists the two bindings of a registry of two and no others, which no component writes into itself', () => {
    const keys = createKeyBindingRegistry('other');
    keys.register({ id: 'one', keys: ['mod+1'], label: 'One', group: 'tools', order: 10, scope: 'workspace', run: () => undefined });
    keys.register({ id: 'two', keys: ['shift+f10'], label: 'Two', group: 'view', order: 10, scope: 'canvas', run: () => undefined });
    const state = createClientState();
    state.presentation.setSheetOpen(true);
    render(
      <ClientStateProvider state={state}>
        <KeyBindingsProvider registry={keys}>
          <ShortcutSheet />
        </KeyBindingsProvider>
      </ClientStateProvider>,
    );
    expect(columns()).toEqual({ TOOLS: ['One Ctrl+1'], VIEW: ['Two Shift+F10'] });
  });

  it('keeps the focus inside when a press lands on its text or on the scrim, so Esc closes it, clears nothing and no other key runs', async () => {
    const state = createClientState();
    load(state);
    workspace(builtInKeyBindings(), state);
    await act(async () => void (await Promise.resolve()));
    act(() => state.presentation.select([nodeKey('n1')]));
    opener();
    const user = userEvent.setup();
    await user.click(within(dialog()).getByText('Select all'));
    expect(document.activeElement).toBe(dialog());
    press('v', {}, document.activeElement ?? document.body);
    press('h', {}, document.activeElement ?? document.body);
    press('a', { metaKey: true }, document.activeElement ?? document.body);
    expect(state.presentation.view.getState().tool).toBe('select');
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n1')]);
    await user.tab();
    expect(dialog().contains(document.activeElement)).toBe(true);
    act(() => dialog().focus());
    await user.tab({ shift: true });
    expect(dialog().contains(document.activeElement)).toBe(true);
    act(() => document.body.focus());
    fireEvent.mouseDown(dialog().parentElement ?? dialog());
    expect(document.activeElement).toBe(dialog());
    press('Escape', {}, dialog());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n1')]);
  });
});
