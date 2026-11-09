import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { createMenuRegistry } from '../workspace/menu-registry.js';
import type { SelectionAction } from '../workspace/selection-actions.js';
import { entity, inInspector, inspector, inspectorRig, keyOf, property, select, spy } from './inspector-kit.js';

const action = (id: string, label: string, run: SelectionAction['run']): SelectionAction => ({ id, label, icon: null, run });

describe('the inspector header', () => {
  it('runs Expand and Pin on this entity only and shows the note an action returns', async () => {
    const expand = spy().mockReturnValue('Loaded 3 neighbors');
    const pin = spy();
    const rig = inspectorRig({ actions: [action('expand', 'Expand', expand), action('pin', 'Pin', pin)] });
    select(rig.state, 'n1');
    const user = userEvent.setup();
    await user.click(inInspector().getByRole('button', { name: 'Pin' }));
    await user.click(inInspector().getByRole('button', { name: 'Expand' }));
    expect(expand).toHaveBeenCalledWith([keyOf('n1')]);
    expect(pin).toHaveBeenCalledWith([keyOf('n1')]);
    expect(inInspector().getByText('Loaded 3 neighbors')).toBeTruthy();
  });

  it('draws no button for an action that is not registered, and no other action', () => {
    const rig = inspectorRig({ actions: [action('expand', 'Expand', spy()), action('group', 'Group', spy())] });
    select(rig.state, 'n1');
    expect(inInspector().getByRole('button', { name: 'Expand' })).toBeTruthy();
    expect(inInspector().queryByRole('button', { name: 'Pin' })).toBeNull();
    expect(inInspector().queryByRole('button', { name: 'Hide' })).toBeNull();
    expect(inInspector().queryByRole('button', { name: 'Group' })).toBeNull();
  });

  it('reads a label that is a function from the entity and the state', () => {
    const rig = inspectorRig({ actions: [{ id: 'pin', label: (selection) => `Pin ${selection.length}`, icon: null, run: spy() }] });
    select(rig.state, 'n1');
    expect(inInspector().getByRole('button', { name: 'Pin 1' })).toBeTruthy();
  });

  it('hides the entity with Hide, closes, and puts the focus on the canvas', async () => {
    const state = createClientState();
    const rig = inspectorRig({ state, actions: [action('hide', 'Hide', (selection) => void state.hide([...selection]))] });
    select(rig.state, 'n1');
    await userEvent.setup().click(inInspector().getByRole('button', { name: 'Hide' }));
    expect(inspector()).toBeNull();
    expect(state.presentation.view.getState().hidden.has(keyOf('n1'))).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('.graph-canvas'));
  });

  it('opens the node menu without the items the buttons already are, operable by keyboard', async () => {
    const rig = inspectorRig({ nodes: [entity('n1', [property('holder', 'J')])] });
    select(rig.state, 'n1');
    const more = inInspector().getByRole('button', { name: 'More actions' });
    await userEvent.setup().click(more);
    const menu = screen.getByRole('menu');
    expect(menu.textContent).not.toContain('Expand neighbors');
    expect(menu.textContent).not.toContain('Pin position');
    expect(menu.textContent).not.toContain('Hide from view');
    expect(menu.textContent).toContain('Focus neighborhood');
    expect(menu.contains(document.activeElement)).toBe(true);
    await userEvent.setup().keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(inspector()).not.toBeNull();
  });

  it('draws no menu button when the node menu has nothing besides the buttons', () => {
    const rig = inspectorRig({ menus: createMenuRegistry() });
    select(rig.state, 'n1');
    expect(inInspector().queryByRole('button', { name: 'More actions' })).toBeNull();
    act(() => undefined);
  });
});
