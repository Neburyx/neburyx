import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { edgeKey } from '../state/keys.js';
import { edge, node } from '../state/test-data.js';
import { registerStandInActions } from '../dev/stand-ins.js';
import { loadGraph, nodeKey } from './context-menu-kit.js';
import { registerBuiltInKeyBindings } from './built-in-key-bindings.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';
import { HideSelectionAction } from './hide-selection-action.js';
import { createKeyListener } from './key-binding-handler.js';
import { createKeyBindingRegistry } from './key-binding-registry.js';
import { createMenuRegistry, stateOf, type MenuContext } from './menu-registry.js';
import { createSelectionActionRegistry, SelectionActionsProvider } from './selection-actions.js';
import { SelectionBar } from './selection-bar.js';

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

const hiddenKeys = (state: ClientState): string[] => [...state.presentation.view.getState().hidden].sort();

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

function menuItem(state: ClientState, id: string, key: string | undefined = nodeKey('n1')) {
  const menus = createMenuRegistry();
  registerBuiltInMenuItems(menus);
  const item = menus.view.getState().get('node')?.find((candidate) => candidate.id === id);
  if (item === undefined || item.run === undefined) throw new Error('no such item');
  const context: MenuContext = { kind: 'node', key, selection: [...state.presentation.view.getState().selection], state, canvas: undefined };
  return () => item.run?.(context);
}

describe('Hide from view by the key', () => {
  it('hides the selected entities on Delete and on Backspace, leaves the relationships, and tells a screen reader', () => {
    const state = graph();
    const { press, stop } = keyboard(state);
    state.presentation.select([nodeKey('n1'), nodeKey('n3'), link]);
    expect(press('Delete').defaultPrevented).toBe(true);
    expect(hiddenKeys(state)).toEqual([nodeKey('n1'), nodeKey('n3')].sort());
    expect(state.presentation.view.getState().selection.size).toBe(0);
    expect(state.presentation.view.getState().moveNote?.text).toBe('Hid 2 entities. Show them again from the scope line.');
    state.presentation.select([nodeKey('n2')]);
    press('Backspace');
    expect(state.presentation.view.getState().hidden.has(nodeKey('n2'))).toBe(true);
    stop();
  });

  it('does nothing and leaves the key to the browser with nothing selected, with only a relationship selected, with a menu open, or in a text field', () => {
    const state = graph();
    const { press, stop } = keyboard(state);
    expect(press('Delete').defaultPrevented).toBe(false);
    state.presentation.select([link]);
    expect(press('Delete').defaultPrevented).toBe(false);
    state.presentation.select([nodeKey('n1')]);
    state.presentation.setOpenMenu({ kind: 'node', key: nodeKey('n1'), x: 1, y: 1 });
    expect(press('Delete').defaultPrevented).toBe(false);
    state.presentation.setOpenMenu(undefined);
    const field = document.body.appendChild(document.createElement('input'));
    expect(press('Backspace', field).defaultPrevented).toBe(false);
    expect(press('Delete', field).defaultPrevented).toBe(false);
    expect(state.presentation.view.getState().hidden.size).toBe(0);
    stop();
  });

  it('lists its key once, as Hide, drawn Del outside macOS and the backspace sign on macOS', () => {
    for (const [platform, shown] of [['mac', '⌫'], ['other', 'Del']] as const) {
      const registry = createKeyBindingRegistry(platform);
      registerBuiltInKeyBindings(registry);
      const row = registry.view.getState().find((binding) => binding.id === 'hide');
      expect([row?.label, row?.shown]).toEqual(['Hide', [shown]]);
    }
  });
});

describe('Hide from view in the node menu', () => {
  it('hides the entity it was opened on when nothing is selected', () => {
    const state = graph();
    menuItem(state, 'hide-from-view', nodeKey('n3'))();
    expect(hiddenKeys(state)).toEqual([nodeKey('n3')]);
  });

  it('hides every selected entity when the entity is one of them, and only the entity when it is not', () => {
    const state = graph();
    state.presentation.select([nodeKey('n1'), nodeKey('n2'), link]);
    menuItem(state, 'hide-from-view', nodeKey('n4'))();
    expect(hiddenKeys(state)).toEqual([nodeKey('n4')]);
    menuItem(state, 'hide-from-view', nodeKey('n1'))();
    expect(hiddenKeys(state)).toEqual([nodeKey('n1'), nodeKey('n2'), nodeKey('n4')].sort());
  });

  it('shows the key of the binding as its hint, and Invert selection runs the one command', () => {
    const menus = createMenuRegistry();
    registerBuiltInMenuItems(menus);
    const items = menus.view.getState().get('node') ?? [];
    expect(items.find((item) => item.id === 'hide-from-view')?.binding).toBe('hide');
    expect(items.find((item) => item.id === 'invert-selection')?.binding).toBe('invert-selection');
    const state = graph();
    state.presentation.select([nodeKey('n1')]);
    menuItem(state, 'invert-selection')();
    expect([...state.presentation.view.getState().selection]).toEqual([nodeKey('n2'), nodeKey('n3'), nodeKey('n4')]);
    state.presentation.select([nodeKey('n1'), nodeKey('n2'), nodeKey('n3'), nodeKey('n4')]);
    menuItem(state, 'invert-selection')();
    expect(state.presentation.view.getState().selection.size).toBe(0);
  });
});

describe('Fit and Layout when every entity is hidden', () => {
  it('are off, as they are for an empty canvas, and on again when the entities are shown', () => {
    const state = graph();
    const menus = createMenuRegistry();
    registerBuiltInMenuItems(menus);
    const layout = menus.view.getState().get('canvas')?.find((candidate) => candidate.id === 'layout');
    if (layout === undefined) throw new Error('no Layout item');
    const context: MenuContext = { kind: 'canvas', key: undefined, selection: [], state, canvas: { layout: () => undefined } as unknown as MenuContext['canvas'] };
    expect(stateOf(layout, context)).toBe('enabled');
    state.hide(['n1', 'n2', 'n3', 'n4'].map(nodeKey));
    expect(stateOf(layout, context)).toBe('disabled');
    state.presentation.showAllHidden();
    expect(stateOf(layout, context)).toBe('enabled');
  });
});

describe('Hide on the selection bar', () => {
  function barred(standIns = false) {
    const state = graph();
    const registry = createSelectionActionRegistry();
    registry.register({ id: 'pin', order: 40, label: 'Pin', icon: null, run: () => undefined });
    render(
      <ClientStateProvider state={state}>
        <SelectionActionsProvider registry={registry}>
          <HideSelectionAction />
          <SelectionBar />
        </SelectionActionsProvider>
      </ClientStateProvider>,
    );
    if (standIns) act(() => void registerStandInActions(registry));
    return state;
  }

  it('hides the selection by the same command, and the bar goes with the selection', async () => {
    const state = barred();
    act(() => state.presentation.select([nodeKey('n1'), nodeKey('n2'), link]));
    await userEvent.setup().click(within(screen.getByRole('toolbar', { name: 'Selection actions' })).getByRole('button', { name: 'Hide' }));
    expect(hiddenKeys(state)).toEqual([nodeKey('n1'), nodeKey('n2')].sort());
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('gives the menu, the key and the bar the same result for the same selection', async () => {
    const results: string[][] = [];
    for (const how of ['menu', 'key', 'bar'] as const) {
      cleanup();
      const state = barred();
      act(() => state.presentation.select([nodeKey('n1'), nodeKey('n3'), link]));
      if (how === 'menu') act(() => menuItem(state, 'hide-from-view', nodeKey('n1'))());
      if (how === 'key') {
        const { press, stop } = keyboard(state);
        press('Delete');
        stop();
      }
      if (how === 'bar') await userEvent.setup().click(screen.getByRole('button', { name: 'Hide' }));
      results.push([...hiddenKeys(state), '|', ...state.presentation.view.getState().selection]);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it('stands after Pin and before Copy IDs, and a stand-in of the same place gives way', () => {
    const state = barred(true);
    act(() => state.presentation.select([nodeKey('n1'), nodeKey('n2')]));
    const labels = within(screen.getByRole('toolbar', { name: 'Selection actions' })).getAllByRole('button').map((button) => button.textContent);
    expect(labels).toEqual(['Expand', 'Paths between', 'Group', 'Pin', 'Hide', 'Copy IDs', '']);
  });
});
