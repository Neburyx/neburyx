import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { registerStandInActions } from '../dev/stand-ins.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { edgeKey } from '../state/keys.js';
import { edge, node } from '../state/test-data.js';
import { loadGraph, nodeKey } from './context-menu-kit.js';
import { HideSelectionAction } from './hide-selection-action.js';
import { PinSelectionAction } from './pin-selection-action.js';
import { createSelectionActionRegistry, SelectionActionsProvider } from './selection-actions.js';
import { SelectionBar } from './selection-bar.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const link = edgeKey(edge('a', 'e1', 'n1', 'n2').ref);
const pinned = (state: ClientState): string[] => [...state.presentation.view.getState().pins].sort();
const said = (state: ClientState): string | undefined => state.presentation.view.getState().moveNote?.text;
const bar = () => within(screen.getByRole('toolbar', { name: 'Selection actions' }));

function barred() {
  const state = createClientState();
  loadGraph(state, [node('a', 'n1'), node('a', 'n2'), node('a', 'n3')], [edge('a', 'e1', 'n1', 'n2'), edge('a', 'e2', 'n2', 'n3')]);
  const registry = createSelectionActionRegistry();
  render(
    <ClientStateProvider state={state}>
      <SelectionActionsProvider registry={registry}>
        <PinSelectionAction />
        <HideSelectionAction />
        <SelectionBar />
      </SelectionActionsProvider>
    </ClientStateProvider>,
  );
  act(() => void registerStandInActions(registry));
  return state;
}

describe('Pin on the selection bar', () => {
  it('stands between Group and Hide, in place of the stand-in', () => {
    const state = barred();
    act(() => state.presentation.select([nodeKey('n1'), nodeKey('n2')]));
    expect(bar().getAllByRole('button').map((button) => button.textContent)).toEqual(['Expand', 'Paths between', 'Group', 'Pin', 'Hide', 'Copy IDs', '']);
  });

  it('pins the selected entities, then reads Unpin and releases them, telling a screen reader each time', async () => {
    const state = barred();
    act(() => state.presentation.select([nodeKey('n1'), nodeKey('n2')]));
    const user = userEvent.setup();
    await user.click(bar().getByRole('button', { name: 'Pin' }));
    expect(pinned(state)).toEqual([nodeKey('n1'), nodeKey('n2')]);
    expect(said(state)).toBe('Pinned 2 entities.');
    await user.click(bar().getByRole('button', { name: 'Unpin' }));
    expect(pinned(state)).toEqual([]);
    expect(said(state)).toBe('Unpinned 2 entities.');
  });

  it('reads Pin for a mixed selection and pins the rest, counting only what changed', async () => {
    const state = barred();
    act(() => state.presentation.pin([nodeKey('n1')]));
    act(() => state.presentation.select([nodeKey('n1'), nodeKey('n2')]));
    await userEvent.setup().click(bar().getByRole('button', { name: 'Pin' }));
    expect(pinned(state)).toEqual([nodeKey('n1'), nodeKey('n2')]);
    expect(said(state)).toBe('Pinned 1 entity.');
  });

  it('redraws its label when a pin changes by another route', () => {
    const state = barred();
    act(() => state.presentation.select([nodeKey('n1'), nodeKey('n2')]));
    act(() => state.presentation.pin([nodeKey('n1'), nodeKey('n2')]));
    expect(bar().getByRole('button', { name: 'Unpin' })).toBeTruthy();
    act(() => state.presentation.unpin([nodeKey('n1')]));
    expect(bar().getByRole('button', { name: 'Pin' })).toBeTruthy();
  });

  it('pins only the entity of an entity and a relationship, and does nothing, silently, for relationships alone', async () => {
    const state = barred();
    act(() => state.presentation.select([nodeKey('n1'), link]));
    await userEvent.setup().click(bar().getByRole('button', { name: 'Pin' }));
    expect(pinned(state)).toEqual([nodeKey('n1')]);
    act(() => state.presentation.unpin([nodeKey('n1')]));
    act(() => state.presentation.select([link, edgeKey(edge('a', 'e2', 'n2', 'n3').ref)]));
    const before = said(state);
    await userEvent.setup().click(bar().getByRole('button', { name: 'Pin' }));
    expect(pinned(state)).toEqual([]);
    expect(said(state)).toBe(before);
  });
});
