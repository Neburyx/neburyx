import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ClientStateProvider } from '../state/context.js';
import { createSelectionActionRegistry } from '../workspace/selection-actions.js';
import { createSlotRegistry, SLOT_NAMES, SlotsProvider, Slot, type SlotName } from '../workspace/slots.js';
import { createToolRegistry, ToolsProvider } from '../workspace/tool-registry.js';
import { edgeKey } from '../state/keys.js';
import { edge, key, node } from '../state/test-data.js';
import { ToolStrip } from '../workspace/tool-strip.js';
import { registerBuiltInMenuItems } from '../workspace/built-in-menu-items.js';
import { createMenuRegistry, type MenuRegistry, type MenuTargetKind } from '../workspace/menu-registry.js';
import { createClientState } from '../state/client-state.js';
import { registerStandInActions, registerStandInMenuItems, registerStandInTools, registerStandIns, STAND_IN_MARKER } from './stand-ins.js';

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

describe('the menu item stand-ins', () => {
  const idsOf = (registry: MenuRegistry, kind: MenuTargetKind): string[] => (registry.view.getState().get(kind) ?? []).map((item) => item.id);
  const labelsOf = (registry: MenuRegistry, kind: MenuTargetKind): string[] => (registry.view.getState().get(kind) ?? []).map((item) => (typeof item.label === 'string' ? item.label : '(from the target)'));

  it('leave the menus of production as they are before they are installed: the canvas menu holds its three items, the entity and relationship menus none', () => {
    const registry = createMenuRegistry();
    registerBuiltInMenuItems(registry);
    expect(idsOf(registry, 'canvas')).toEqual(['fit-to-view', 'select-all', 'invert-selection']);
    expect(idsOf(registry, 'node')).toEqual([]);
    expect(idsOf(registry, 'relationship')).toEqual([]);
  });

  it('fill the places of the items of the design in each menu, in the design order, after the real items of the canvas menu', () => {
    const registry = createMenuRegistry();
    registerBuiltInMenuItems(registry);
    registerStandInMenuItems(registry);
    expect(labelsOf(registry, 'canvas')).toEqual(['Fit to view', 'Select all', 'Invert selection', 'Group all by type', 'Ungroup all', 'Layout', 'Show legend', 'Export view…']);
    expect(labelsOf(registry, 'node')).toEqual([
      'Expand neighbors', 'Expand by type', 'Focus neighborhood', 'Find paths from here…', 'Find paths to…', 'Run pattern', 'Select neighbors', 'Invert selection', 'Group by type', 'Pin position', 'Hide from view', 'Copy ID', 'Copy properties', 'Open source record', 'Ask about this entity', 'Summarize neighborhood',
    ]);
    expect(labelsOf(registry, 'relationship')).toEqual([
      'Why is this relationship here?', 'View supporting records', 'Highlight endpoints', 'Select both endpoints', 'Find paths between endpoints', 'Hide this relationship', '(from the target)', '(from the target)', 'Copy relationship ID', 'Copy properties', 'Open source record', 'Ask about this relationship',
    ]);
  });

  it('name the items that carry a type from the relationship that was right-clicked, and from nothing fixed in the code', () => {
    const registry = createMenuRegistry();
    registerStandInMenuItems(registry);
    const state = createClientState();
    state.bindSource('a');
    const base = edge('a', 'e1', 'n1', 'n2');
    const shared = { ...base, type: 'custom-type' };
    state.putResult(key('a'), { sourceId: 'a', nodes: [node('a', 'n1'), node('a', 'n2')], edges: [shared] });
    state.setLoaded([key('a')], [shared.from, shared.to], [shared.ref]);
    const context = { kind: 'relationship' as const, key: edgeKey(shared.ref), selection: [], state, canvas: undefined };
    const items = registry.view.getState().get('relationship') ?? [];
    const label = (id: string): string | undefined => {
      const found = items.find((item) => item.id === id)?.label;
      return typeof found === 'function' ? found(context) : found;
    };
    expect(label('stand-in-hide-all')).toBe('Hide all custom-type');
    expect(label('stand-in-show-only')).toBe('Show only custom-type');
  });

  it('draw the frame states: a locked Ask with a lock, a locked Summarize without one, a disabled relationship record, submenus on four rows of the entity and canvas menus', () => {
    const registry = createMenuRegistry();
    registerStandInMenuItems(registry);
    const by = (kind: MenuTargetKind, id: string) => registry.view.getState().get(kind)?.find((item) => item.id === id);
    expect(by('node', 'stand-in-ask')).toMatchObject({ state: 'locked', lock: true });
    expect(by('node', 'stand-in-summarize')?.state).toBe('locked');
    expect(by('node', 'stand-in-summarize')?.lock).toBeUndefined();
    expect(by('relationship', 'stand-in-open-relationship-record')?.state).toBe('disabled');
    expect(by('relationship', 'stand-in-ask-relationship')).toMatchObject({ state: 'locked', lock: true });
    const parents: readonly (readonly [MenuTargetKind, string])[] = [
      ['canvas', 'stand-in-group-all'],
      ['canvas', 'stand-in-layout'],
      ['node', 'stand-in-expand-by-type'],
      ['node', 'stand-in-run-pattern'],
      ['node', 'stand-in-group-by-type'],
    ];
    expect(parents.map(([kind, id]) => by(kind, id)?.submenu !== undefined)).toEqual([true, true, true, true, true]);
  });

  it('leave a place that is taken alone for the same kind, keep every real registration, add nothing twice and take out only what they added', () => {
    const registry = createMenuRegistry();
    const real = { id: 'stand-in-layout', label: 'Real layout', icon: null, group: 30, order: 10, run: () => undefined };
    registry.register('canvas', real);
    registerBuiltInMenuItems(registry);
    const remove = registerStandInMenuItems(registry);
    registerStandInMenuItems(registry);
    expect(labelsOf(registry, 'canvas').filter((label) => label === 'Real layout')).toHaveLength(1);
    expect(idsOf(registry, 'canvas').filter((id) => id === 'stand-in-layout')).toHaveLength(1);
    expect(registry.view.getState().get('canvas')?.find((item) => item.id === 'stand-in-layout')?.label).toBe('Real layout');
    remove();
    expect(idsOf(registry, 'canvas')).toEqual(['fit-to-view', 'select-all', 'invert-selection', 'stand-in-layout']);
    expect(idsOf(registry, 'node')).toEqual([]);
  });
});
