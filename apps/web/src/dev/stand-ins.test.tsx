import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { createSelectionActionRegistry } from '../workspace/selection-actions.js';
import { createSlotRegistry, SLOT_NAMES, SlotsProvider, Slot, type SlotName } from '../workspace/slots.js';
import { registerStandInActions, registerStandIns } from './stand-ins.js';

const BUILT_LATER: readonly SlotName[] = SLOT_NAMES.filter((name) => name !== 'ask' && name !== 'summarize');

describe('the slot stand-ins', () => {
  it('fill every slot whose occupant is not built, and not Ask or Summarize', () => {
    const registry = createSlotRegistry();
    registerStandIns(registry);
    expect([...registry.view.getState().keys()].sort()).toEqual([...BUILT_LATER].sort());
  });

  it('leave an occupied slot as it is, fill the free ones and do not throw', () => {
    const registry = createSlotRegistry();
    const save = () => null;
    registry.register('save', save);
    expect(() => registerStandIns(registry)).not.toThrow();
    expect(registry.view.getState().get('save')).toBe(save);
    expect(registry.view.getState().size).toBe(BUILT_LATER.length);
  });

  it('fill a slot that was freed when asked again, and add nothing twice', () => {
    const registry = createSlotRegistry();
    const remove = registry.register('save', () => null);
    registerStandIns(registry);
    remove();
    registerStandIns(registry);
    registerStandIns(registry);
    expect(registry.view.getState().size).toBe(BUILT_LATER.length);
  });

  it('are taken out by the function they return, and only what they put in', () => {
    const registry = createSlotRegistry();
    const save = () => null;
    registry.register('save', save);
    const remove = registerStandIns(registry);
    remove();
    expect([...registry.view.getState().keys()]).toEqual(['save']);
  });
});

describe('the selection action stand-ins', () => {
  const labels = (registry: ReturnType<typeof createSelectionActionRegistry>) => registry.view.getState().map((action) => action.label);

  it('fill the places of the actions that are not built yet, in the order of the design', () => {
    const registry = createSelectionActionRegistry();
    registerStandInActions(registry);
    expect(labels(registry)).toEqual(['Expand', 'Paths between', 'Group', 'Pin', 'Hide']);
  });

  it('leave a place that is taken alone, add nothing twice and do not throw', () => {
    const registry = createSelectionActionRegistry();
    registry.register({ id: 'stand-in-pin', label: 'Real pin', icon: null, run: () => undefined });
    expect(() => registerStandInActions(registry)).not.toThrow();
    registerStandInActions(registry);
    expect(labels(registry)).toEqual(['Real pin', 'Expand', 'Paths between', 'Group', 'Hide']);
  });

  it('are taken out by the function they return, and only what they put in', () => {
    const registry = createSelectionActionRegistry();
    registry.register({ id: 'stand-in-pin', label: 'Real pin', icon: null, run: () => undefined });
    registerStandInActions(registry)();
    expect(labels(registry)).toEqual(['Real pin']);
  });
});

describe('the pointer mode stand-in', () => {
  it('shows the three modes as pressed buttons and changes the mode when one is pressed', async () => {
    const state = createClientState();
    const registry = createSlotRegistry();
    registerStandIns(registry);
    render(
      <ClientStateProvider state={state}>
        <SlotsProvider registry={registry}>
          <Slot name="tool-strip" />
        </SlotsProvider>
      </ClientStateProvider>,
    );
    const mode = (name: string) => screen.getByRole('button', { name });
    expect(mode('Select').getAttribute('aria-pressed')).toBe('true');
    const user = userEvent.setup();
    await user.click(mode('Box select'));
    expect(state.presentation.view.getState().tool).toBe('box');
    expect(mode('Box select').getAttribute('aria-pressed')).toBe('true');
    expect(mode('Select').getAttribute('aria-pressed')).toBe('false');
    act(() => state.presentation.setTool('pan'));
    expect(mode('Pan').getAttribute('aria-pressed')).toBe('true');
  });
});
