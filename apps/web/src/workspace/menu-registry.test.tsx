import { describe, expect, it } from 'vitest';
import { createMenuRegistry, MENU_GROUP, MENU_ORDER, MenuItemError, type MenuItem, type MenuRegistry, type MenuTargetKind } from './menu-registry.js';

const item = (id: string, group = 10, order = 10): MenuItem => ({ id, label: id, icon: null, group, order, run: () => undefined });
const ids = (registry: MenuRegistry, kind: MenuTargetKind): string[] => (registry.view.getState().get(kind) ?? []).map((registered) => registered.id);

describe('the menu registry', () => {
  it('refuses a second item with an ID that is registered for the same kind, with MENU_ITEM_TAKEN, and keeps the first', () => {
    const registry = createMenuRegistry();
    registry.register('canvas', item('a'));
    expect(() => registry.register('canvas', item('a'))).toThrow(MenuItemError);
    expect(() => registry.register('canvas', item('a'))).toThrow('MENU_ITEM_TAKEN: canvas/a');
    expect(ids(registry, 'canvas')).toEqual(['a']);
  });

  it('takes the same ID for another kind, and lists an item only in the menu of its kind', () => {
    const registry = createMenuRegistry();
    registry.register('node', item('same'));
    registry.register('relationship', item('same'));
    registry.register('node', item('only-node'));
    expect(ids(registry, 'node')).toEqual(['same', 'only-node']);
    expect(ids(registry, 'relationship')).toEqual(['same']);
    expect(ids(registry, 'canvas')).toEqual([]);
  });

  it('lists items by group, then by order, then by the order they were registered', () => {
    const registry = createMenuRegistry();
    registry.register('canvas', item('late-group', 20, 10));
    registry.register('canvas', item('first-tie', 10, 20));
    registry.register('canvas', item('early', 10, 10));
    registry.register('canvas', item('second-tie', 10, 20));
    expect(ids(registry, 'canvas')).toEqual(['early', 'first-tie', 'second-tie', 'late-group']);
  });

  it('takes out only the registration its function belongs to, and does nothing when it is called again', () => {
    const registry = createMenuRegistry();
    const removeA = registry.register('canvas', item('a'));
    registry.register('canvas', item('b', 10, 20));
    removeA();
    removeA();
    expect(ids(registry, 'canvas')).toEqual(['b']);
  });

  it('does not let the function of an earlier registration take out a later registration of the same ID', () => {
    const registry = createMenuRegistry();
    const removeOld = registry.register('canvas', item('a'));
    removeOld();
    registry.register('canvas', item('a'));
    removeOld();
    expect(ids(registry, 'canvas')).toEqual(['a']);
  });

  it('gives each registration its own number, also to an ID registered again', () => {
    const registry = createMenuRegistry();
    const remove = registry.register('canvas', item('a'));
    const first = registry.view.getState().get('canvas')?.[0]?.registration;
    remove();
    registry.register('canvas', item('a'));
    expect(registry.view.getState().get('canvas')?.[0]?.registration).not.toBe(first);
  });

  it('holds the groups and orders of the canvas menu of the design in the order they are drawn', () => {
    const groups = [MENU_GROUP.canvas.view, MENU_GROUP.canvas.grouping, MENU_GROUP.canvas.layoutAndLegend, MENU_GROUP.canvas.export];
    expect(groups).toEqual([...groups].sort((a, b) => a - b));
    expect(new Set(groups).size).toBe(4);
    expect([MENU_ORDER.canvas.fit, MENU_ORDER.canvas.selectAll, MENU_ORDER.canvas.invertSelection]).toEqual([10, 20, 30]);
  });
});
