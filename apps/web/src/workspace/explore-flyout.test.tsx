import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { GraphCanvas } from '../canvas/graph-canvas.js';
import { RendererProvider } from '../canvas/renderer-context.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { elementKey } from '../state/keys.js';
import { key, ref, result } from '../state/test-data.js';
import { builtInKeyBindings, canvasSummary, stubFactory } from '../test-utils.js';
import { registerBuiltInTools } from './built-in-tools.js';
import { KeyBindingsProvider } from './key-binding-registry.js';
import { createSelectionActionRegistry, SelectionActionsProvider } from './selection-actions.js';
import { SelectionBar } from './selection-bar.js';
import { createToolRegistry, ToolsProvider } from './tool-registry.js';
import { ToolStrip } from './tool-strip.js';

const ids = ['n1', 'n2', 'n3'];
const nodeKey = (id: string): string => elementKey(ref('a', 'type-a', id));

function load(state: ClientState, nodeIds: readonly string[]): void {
  state.bindSource('a');
  state.putResult(key('a'), result('a', [...nodeIds], []));
  state.setLoaded([key('a')], nodeIds.map((id) => ref('a', 'type-a', id)), []);
}

function show(state: ClientState) {
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  render(
    <ClientStateProvider state={state}>
      <ToolsProvider registry={tools}>
        <SelectionActionsProvider registry={createSelectionActionRegistry()}>
          <KeyBindingsProvider registry={builtInKeyBindings()}>
            <RendererProvider createRenderer={stubFactory().create}>
              <GraphCanvas />
              <ToolStrip />
              <SelectionBar />
            </RendererProvider>
          </KeyBindingsProvider>
        </SelectionActionsProvider>
      </ToolsProvider>
    </ClientStateProvider>,
  );
}

const open = async (): Promise<void> => {
  await userEvent.setup().click(screen.getByRole('button', { name: 'Explore' }));
};
const flyout = (): HTMLElement => screen.getByRole('menu', { name: 'Explore' });
const row = (name: string): HTMLElement => within(flyout()).getByRole(['Select', 'Pan', 'Box select'].includes(name) ? 'menuitemradio' : 'menuitem', { name });
const selection = (state: ClientState): string[] => [...state.presentation.view.getState().selection].sort();

describe('the selection commands in the Explore flyout', () => {
  it('lists Select all, Invert selection and Clear selection below a divider, with their hints and no mark of being chosen', async () => {
    show(createClientState());
    await open();
    const rows = [...within(flyout()).getAllByRole('menuitemradio'), ...within(flyout()).getAllByRole('menuitem')];
    expect(rows.map((button) => button.textContent)).toEqual(['SelectV', 'PanH', 'Box selectB', 'Select all⌘A', 'Invert selection⇧⌘I', 'Clear selectionEsc']);
    expect(within(flyout()).getAllByRole('separator')).toHaveLength(1);
    for (const name of ['Select all', 'Invert selection', 'Clear selection']) {
      expect(row(name).getAttribute('aria-checked')).toBeNull();
      expect(row(name).querySelector('.icon-check')).toBeNull();
    }
    expect(rows.slice(0, 3).map((button) => button.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
  });

  it('runs each command on the drawn entities, closes the flyout and leaves the pointer mode alone', async () => {
    const state = createClientState();
    load(state, ids);
    show(state);
    state.presentation.setTool('pan');
    await open();
    await userEvent.setup().click(row('Select all'));
    expect(selection(state)).toEqual(ids.map(nodeKey).sort());
    expect(screen.queryByRole('menu', { name: 'Explore' })).toBeNull();
    expect(state.presentation.view.getState().tool).toBe('pan');
    act(() => state.presentation.select([nodeKey('n1')]));
    await open();
    await userEvent.setup().click(row('Invert selection'));
    expect(selection(state)).toEqual([nodeKey('n2'), nodeKey('n3')]);
    await open();
    await userEvent.setup().click(row('Clear selection'));
    expect(selection(state)).toEqual([]);
    expect(state.presentation.view.getState().tool).toBe('pan');
  });

  it('does nothing, throws nothing and still closes when nothing is drawn or nothing is selected', async () => {
    const state = createClientState();
    show(state);
    const user = userEvent.setup();
    const before = state.presentation.view.getState();
    for (const name of ['Select all', 'Invert selection', 'Clear selection']) {
      await user.click(screen.getByRole('button', { name: 'Explore' }));
      await user.click(row(name));
      expect(screen.queryByRole('menu', { name: 'Explore' })).toBeNull();
      expect(selection(state)).toEqual([]);
    }
    expect({ ...state.presentation.view.getState(), openTool: undefined }).toEqual({ ...before, openTool: undefined });
    load(state, ids);
    await user.click(screen.getByRole('button', { name: 'Explore' }));
    const unselected = state.presentation.view.getState().selection;
    await user.click(row('Clear selection'));
    expect(state.presentation.view.getState().selection).toBe(unselected);
  });

  it('shows the new selection in the selection bar and in the canvas description, which read the same state', async () => {
    const state = createClientState();
    load(state, ids);
    show(state);
    expect(screen.queryByRole('toolbar', { name: 'Selection actions' })).toBeNull();
    await open();
    await userEvent.setup().click(row('Select all'));
    const bar = screen.getByRole('toolbar', { name: 'Selection actions' });
    expect(within(bar).getByText('3 selected')).not.toBeNull();
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    expect(canvasSummary(canvas)).toBe('3 entities and 0 relationships loaded; 3 selected');
  });
});
