import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { createSelectionActionRegistry } from '../workspace/selection-actions.js';
import { createSlotRegistry, SLOT_NAMES, SlotsProvider, Slot, type SlotName } from '../workspace/slots.js';
import { createToolRegistry, ToolsProvider } from '../workspace/tool-registry.js';
import { ToolStrip } from '../workspace/tool-strip.js';
import { registerStandInActions, registerStandInTools, registerStandIns, STAND_IN_MARKER } from './stand-ins.js';

const BUILT_LATER: readonly SlotName[] = SLOT_NAMES.filter((name) => name !== 'ask' && name !== 'summarize' && name !== 'tool-strip');

describe('the slot stand-ins', () => {
  it('fill every slot whose occupant is not built, and not Ask, Summarize or the tool strip', () => {
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

describe('the tool stand-ins', () => {
  const ids = (registry: ReturnType<typeof createToolRegistry>) => registry.view.getState().map((tool) => tool.id);
  const entry = (id: string, order: number) => ({ id, label: id, icon: null, order, kind: { type: 'action' as const, activate: () => undefined } });

  it('fill the places of the tools that are not built yet, in the order of the reference sheet, named by tool', () => {
    const registry = createToolRegistry();
    registry.register(entry('explore', 10));
    registerStandInTools(registry);
    expect(ids(registry)).toEqual(['explore', 'filters', 'paths', 'patterns', 'search', 'group', 'table']);
    expect(registry.view.getState().map((tool) => tool.label)).toEqual(['explore', 'Filters', 'Paths', 'Patterns', 'Search', 'Group', 'Table']);
  });

  it('carry the development marker on the icon of each of the six buttons', () => {
    const registry = createToolRegistry();
    registerStandInTools(registry);
    render(
      <ClientStateProvider state={createClientState()}>
        <ToolsProvider registry={registry}>
          <ToolStrip />
        </ToolsProvider>
      </ClientStateProvider>,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(6);
    for (const button of buttons) expect(button.querySelector(`[data-dev-tool="${STAND_IN_MARKER}"]`)).not.toBeNull();
  });

  it('leave a place that is taken alone, add nothing twice and do not throw', () => {
    const registry = createToolRegistry();
    const real = entry('paths', 30);
    registry.register(real);
    expect(() => registerStandInTools(registry)).not.toThrow();
    registerStandInTools(registry);
    expect(ids(registry)).toEqual(['filters', 'paths', 'patterns', 'search', 'group', 'table']);
    expect(registry.view.getState()[1]?.kind).toBe(real.kind);
  });

  it('are taken out by the function they return, and only what they put in', () => {
    const registry = createToolRegistry();
    registry.register(entry('paths', 30));
    registerStandInTools(registry)();
    expect(ids(registry)).toEqual(['paths']);
  });
});
