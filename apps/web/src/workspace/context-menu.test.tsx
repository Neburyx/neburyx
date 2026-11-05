import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect, type ComponentType, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RENDERER_UNAVAILABLE } from '../canvas/graph-canvas.js';
import type { RightClick } from '../canvas/scene.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { useLoadedGraph } from '../state/context.js';
import { edgeKey, elementKey } from '../state/keys.js';
import type { PointerTool } from '../state/presentation-state.js';
import type { Count, EdgeRef, GraphEdge, GraphNode } from '@neburyx/contracts';
import { edge, key, node, ref } from '../state/test-data.js';
import { commandItem, ids, item, load, loadGraph, menu, nodeKey, onCanvas, placeOf, selection, show, withBuiltIns, type CommandOptions } from './context-menu-kit.js';
import { LOCK_TOOLTIP } from './locked-control.js';
import { createMenuRegistry, type MenuItem, type MenuRegistry, type MenuItemState, type SubmenuProps } from './menu-registry.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the canvas menu', () => {
  it('is not open until a right-click, and then opens 8 px right of and below the pointer, named Canvas, with no header', () => {
    const state = createClientState();
    load(state);
    const { rightClick } = show(state);
    expect(screen.queryByRole('menu')).toBeNull();
    rightClick(onCanvas(100, 200));
    expect(placeOf()).toEqual({ left: '108px', top: '208px' });
    expect(within(menu()).queryByRole('heading')).toBeNull();
  });

  it('lists Fit to view, Select all and Invert selection with their hints in one group, then Layout and Show legend in the next, with one separator between', () => {
    const state = createClientState();
    load(state);
    const { rightClick } = show(state);
    rightClick(onCanvas(10, 10));
    const rows = within(menu()).getAllByRole('menuitem');
    expect(rows.map((row) => row.textContent)).toEqual(['Fit to view⌘0', 'Select all⌘A', 'Invert selection⇧⌘I', 'Layout', 'Show legendL']);
    expect(rows.map((row) => row.querySelector('.menu-label')?.textContent)).toEqual(['Fit to view', 'Select all', 'Invert selection', 'Layout', 'Show legend']);
    expect(within(menu()).queryAllByRole('separator')).toHaveLength(1);
    expect(item('Fit to view')).toBe(rows[0]);
  });

  it('runs the same fit as the Fit button of the zoom controls, and closes', async () => {
    const state = createClientState();
    load(state);
    const { factory, rightClick } = show(state);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Fit to view' }));
    expect(factory.made[0]?.fits).toBe(1);
    rightClick(onCanvas(10, 10));
    await user.click(item('Fit to view'));
    expect(factory.made[0]?.fits).toBe(2);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('runs Select all and Invert selection as the Explore flyout does, and closes after each', async () => {
    const state = createClientState();
    load(state);
    const { rightClick } = show(state);
    const user = userEvent.setup();
    rightClick(onCanvas(10, 10));
    await user.click(item('Select all'));
    expect(selection(state)).toEqual(ids.map(nodeKey).sort());
    expect(screen.queryByRole('menu')).toBeNull();
    act(() => state.presentation.select([nodeKey('n1')]));
    rightClick(onCanvas(10, 10));
    await user.click(item('Invert selection'));
    expect(selection(state)).toEqual([nodeKey('n2'), nodeKey('n3')]);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape and leaves the selection as it was', async () => {
    const state = createClientState();
    load(state);
    act(() => state.presentation.select([nodeKey('n1')]));
    const { rightClick } = show(state);
    rightClick(onCanvas(10, 10));
    await userEvent.setup().keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(selection(state)).toEqual([nodeKey('n1')]);
    expect(state.presentation.view.getState().openMenu).toBeUndefined();
  });

  it.each<PointerTool>(['select', 'pan', 'box'])('closes on a press outside it in the mode %s, changes no selection by closing, and the press still does what it does', async (tool) => {
    const state = createClientState();
    load(state);
    act(() => {
      state.presentation.setTool(tool);
      state.presentation.select([nodeKey('n1')]);
    });
    const { outside, rightClick } = show(state);
    rightClick(onCanvas(10, 10));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(outside).toHaveBeenCalledTimes(1);
    expect(selection(state)).toEqual([nodeKey('n1')]);
  });

  it('does not close on a press inside it that chooses nothing', async () => {
    const state = createClientState();
    load(state);
    const { rightClick } = show(state);
    rightClick(onCanvas(10, 10));
    await userEvent.setup().click(menu());
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('is replaced by a menu at the new place on a second right-click, never two at once', () => {
    const state = createClientState();
    load(state);
    const { rightClick } = show(state);
    rightClick(onCanvas(10, 10));
    rightClick(onCanvas(300, 400));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(placeOf()).toEqual({ left: '308px', top: '408px' });
  });

  it('leaves the selection as it was when it opens on empty canvas', () => {
    const state = createClientState();
    load(state);
    act(() => state.presentation.select([nodeKey('n1'), nodeKey('n2')]));
    const { rightClick } = show(state);
    rightClick(onCanvas(10, 10));
    expect(selection(state)).toEqual([nodeKey('n1'), nodeKey('n2')].sort());
  });

  it('does not open, and does not throw, when the renderer cannot start, and the notice stays', () => {
    const state = createClientState();
    load(state);
    const { factory } = show(state, { failOn: 'mount' });
    expect(factory.made[0]?.events).toEqual([]);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(RENDERER_UNAVAILABLE);
  });

  it('closes when another source is bound, which resets presentation state', () => {
    const state = createClientState();
    load(state);
    const { rightClick } = show(state);
    rightClick(onCanvas(10, 10));
    act(() => state.bindSource('b'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(state.presentation.view.getState().openMenu).toBeUndefined();
  });

  it('does nothing, throws nothing and still closes for each command when nothing is drawn', async () => {
    const state = createClientState();
    state.bindSource('a');
    const { rightClick } = show(state);
    const user = userEvent.setup();
    for (const name of ['Fit to view', 'Select all', 'Invert selection']) {
      rightClick(onCanvas(10, 10));
      await user.click(item(name));
      expect(screen.queryByRole('menu')).toBeNull();
      expect(selection(state)).toEqual([]);
    }
  });

  it('names an item from the menu context when its label is a function, and hands the command that context', async () => {
    const state = createClientState();
    load(state);
    const menus = withBuiltIns();
    const run = vi.fn();
    const extra: MenuItem = { id: 'extra', label: (context) => `Acts on ${context.kind}`, icon: null, group: 20, order: 10, run };
    menus.register('canvas', extra);
    const { rightClick } = show(state, {}, menus);
    rightClick(onCanvas(10, 10));
    expect(within(menu()).getAllByRole('separator')).toHaveLength(2);
    await userEvent.setup().click(item('Acts on canvas'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ kind: 'canvas', key: undefined, selection: [] });
  });
});

describe('the canvas menu near the edges of the window', () => {
  const size = { width: 186, height: 104 };
  const placing = (window: { width: number; height: number }): void => {
    Object.defineProperty(globalThis.window, 'innerWidth', { configurable: true, value: window.width });
    Object.defineProperty(globalThis.window, 'innerHeight', { configurable: true, value: window.height });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function measured(this: Element) {
      const own = this.classList.contains('context-menu') ? size : { width: 0, height: 0 };
      return { ...own, x: 0, y: 0, top: 0, left: 0, right: own.width, bottom: own.height, toJSON: () => ({}) };
    });
  };

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
    size.width = 186;
  });

  it('opens left of the pointer near the right edge and above it near the bottom edge, wholly inside the window', () => {
    const state = createClientState();
    load(state);
    placing({ width: 1000, height: 700 });
    const { rightClick } = show(state);
    rightClick(onCanvas(900, 100));
    expect(placeOf()).toEqual({ left: `${900 - 8 - 186}px`, top: '108px' });
    rightClick(onCanvas(100, 650));
    expect(placeOf()).toEqual({ left: '108px', top: `${650 - 8 - 104}px` });
    rightClick(onCanvas(995, 695));
    expect(placeOf()).toEqual({ left: `${995 - 8 - 186}px`, top: `${695 - 8 - 104}px` });
  });

  it('keeps the exact offset away from every edge', () => {
    const state = createClientState();
    load(state);
    placing({ width: 1000, height: 700 });
    const { rightClick } = show(state);
    rightClick(onCanvas(400, 300));
    expect(placeOf()).toEqual({ left: '408px', top: '308px' });
  });

  it('holds a menu larger than the window at 8 px from its top left corner', () => {
    const state = createClientState();
    load(state);
    placing({ width: 150, height: 90 });
    const { rightClick } = show(state);
    rightClick(onCanvas(20, 20));
    expect(placeOf()).toEqual({ left: '8px', top: '8px' });
  });

  it('places the menu again when what it holds changes its size, away from the edge it was flipped from', () => {
    const state = createClientState();
    load(state);
    placing({ width: 1000, height: 700 });
    const menus = withBuiltIns();
    const { rightClick } = show(state, {}, menus);
    rightClick(onCanvas(900, 100));
    expect(placeOf().left).toBe(`${900 - 8 - 186}px`);
    size.width = 300;
    act(() => {
      menus.register('canvas', { id: 'wider', label: 'Wider', icon: null, group: 20, order: 10, run: () => undefined });
    });
    expect(placeOf().left).toBe(`${900 - 8 - 300}px`);
  });

  it('closes when the window is resized and when it loses focus', () => {
    const state = createClientState();
    load(state);
    const { rightClick } = show(state);
    rightClick(onCanvas(10, 10));
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(screen.queryByRole('menu')).toBeNull();
    rightClick(onCanvas(10, 10));
    act(() => void window.dispatchEvent(new Event('blur')));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(state.presentation.view.getState().openMenu).toBeUndefined();
  });
});

const withEdgeRef = (id: string, edgeRef: EdgeRef): GraphEdge => ({ ...edge('a', id, 'n1', 'n2'), ref: edgeRef });
const end = (id: string) => ref('a', 'type-a', id);
const count = (value: number | undefined, quality: Count['quality']): Count => ({ value, quality, scope: 'the loaded graph' });
const derivation = { ruleId: 'SD-01', ruleVersion: 2, supportingEdgeRefs: [] };

const stored = edge('a', 'e-stored', 'n1', 'n2');
const derived: GraphEdge = { ...withEdgeRef('e-derived', { sourceId: 'a', derived: { ruleId: 'SD-01', from: end('n1'), to: end('n2') } }), semantics: 'derived', derivation };
const unknownOrigin: GraphEdge = { ...edge('a', 'e-unknown', 'n1', 'n2'), semantics: 'unknown' };
const aggregate = (id: string, memberCount: Count | undefined, overrides: Partial<GraphEdge> = {}): GraphEdge => ({ ...withEdgeRef(id, { sourceId: 'a', aggregate: { type: 'rel-a', from: end('n1'), to: end('n2') } }), ...(memberCount === undefined ? {} : { memberCount }), ...overrides });

const rightClickOn = (kind: 'node' | 'relationship', target: string, at = { x: 50, y: 60 }): RightClick => ({ target: { kind, key: target }, ...at });
const headerOf = (name: string): { readonly title: string; readonly detail: string } => {
  const found = screen.getByRole('menu', { name });
  return { title: found.querySelector('.menu-header-title')?.textContent ?? '', detail: found.querySelector('.menu-header-detail')?.textContent ?? '' };
};

describe('the menu of an entity', () => {
  const jordan: GraphNode = { ...node('a', 'n1'), display: { title: 'Jordan Lee', type: 'type-a' } };

  it('opens at the pointer with the entity ref and its type under it, also when its title differs from its ref, and is named by the ref', () => {
    const state = createClientState();
    loadGraph(state, [jordan, node('a', 'n2')], []);
    const { rightClick } = show(state);
    rightClick(rightClickOn('node', nodeKey('n1'), { x: 100, y: 200 }));
    expect(headerOf('n1')).toEqual({ title: 'n1', detail: 'TYPE-A' });
    expect(screen.queryByText('Jordan Lee')).toBeNull();
    expect(placeOf()).toEqual({ left: '108px', top: '208px' });
  });

  it('shows the header only when no item is registered for entities, and a registered entity item only in the entity menu', () => {
    const state = createClientState();
    loadGraph(state, [jordan, node('a', 'n2')], [stored]);
    const menus = withBuiltIns();
    menus.register('node', { id: 'entity-item', label: 'Entity item', icon: null, group: 10, order: 10, run: () => undefined });
    const { rightClick } = show(state, {}, menus);
    rightClick(rightClickOn('node', nodeKey('n1')));
    expect(within(screen.getByRole('menu', { name: 'n1' })).getAllByRole('menuitem').map((row) => row.textContent)).toEqual(['Entity item']);
    rightClick(rightClickOn('relationship', edgeKey(stored.ref)));
    expect(within(screen.getByRole('menu')).queryAllByRole('menuitem')).toEqual([]);
    rightClick(onCanvas(5, 5));
    expect(within(menu()).getAllByRole('menuitem').map((row) => row.querySelector('.menu-label')?.textContent)).toEqual(['Fit to view', 'Select all', 'Invert selection', 'Layout', 'Show legend']);
  });

  it('shows only the header of an entity menu when nothing is registered at all', () => {
    const state = createClientState();
    loadGraph(state, [jordan, node('a', 'n2')], []);
    const { rightClick } = show(state, {}, createMenuRegistry());
    rightClick(rightClickOn('node', nodeKey('n1')));
    expect(within(screen.getByRole('menu', { name: 'n1' })).queryAllByRole('menuitem')).toEqual([]);
    expect(headerOf('n1').title).toBe('n1');
  });
});

describe('the menu of a relationship', () => {
  const header = (edgeUnderTest: GraphEdge): { readonly title: string; readonly detail: string } => {
    cleanup();
    const state = createClientState();
    loadGraph(state, [node('a', 'n1'), node('a', 'n2')], [edgeUnderTest]);
    const { rightClick } = show(state);
    rightClick(rightClickOn('relationship', edgeKey(edgeUnderTest.ref)));
    const found = screen.getByRole('menu');
    return { title: found.querySelector('.menu-header-title')?.textContent ?? '', detail: found.querySelector('.menu-header-detail')?.textContent ?? '' };
  };

  it('names a stored relationship by its type and "sourced", over its endpoints', () => {
    expect(header(stored)).toEqual({ title: 'rel-a · sourced', detail: 'n1 ↔ n2' });
  });

  it('names a derived relationship by its type and "derived", over its endpoints, the rule and its version', () => {
    expect(header(derived)).toEqual({ title: 'rel-a · derived', detail: 'n1 ↔ n2 · SD-01 v2' });
  });

  it('names an unknown origin "origin unknown" and shows no rule', () => {
    expect(header(unknownOrigin)).toEqual({ title: 'rel-a · origin unknown', detail: 'n1 ↔ n2' });
  });

  it('shows the rule of a derived aggregate and not of an aggregate of unknown origin', () => {
    expect(header(aggregate('e-agg-derived', count(42, 'exact'), { semantics: 'derived', derivation }))).toEqual({ title: 'rel-a · 42 · derived', detail: 'n1 ↔ n2 · SD-01 v2' });
    expect(header(aggregate('e-agg-unknown', count(42, 'exact'), { semantics: 'unknown' }))).toEqual({ title: 'rel-a · 42 · origin unknown', detail: 'n1 ↔ n2' });
  });

  it.each<[string, Count | undefined, string]>([
    ['exact', count(42, 'exact'), 'rel-a · 42 · sourced'],
    ['estimated', count(42, 'estimated'), 'rel-a · ~42 (estimated) · sourced'],
    ['lower bound', count(42, 'lowerBound'), 'rel-a · ≥ 42 (lower bound) · sourced'],
    ['unknown', count(undefined, 'unknown'), 'rel-a · sourced'],
    ['not given', undefined, 'rel-a · sourced'],
  ])('writes the member count of an aggregate as the canvas does when it is %s, with no number when it is unknown', (_name, memberCount, title) => {
    expect(header(aggregate('e-agg', memberCount)).title).toBe(title);
  });

  it('opens a menu named by that title, where only an item registered for relationships appears', () => {
    const state = createClientState();
    loadGraph(state, [node('a', 'n1'), node('a', 'n2')], [derived]);
    const menus = withBuiltIns();
    menus.register('relationship', { id: 'relationship-item', label: 'Relationship item', icon: null, group: 10, order: 10, run: () => undefined });
    menus.register('node', { id: 'entity-item', label: 'Entity item', icon: null, group: 10, order: 10, run: () => undefined });
    const { rightClick } = show(state, {}, menus);
    rightClick(rightClickOn('relationship', edgeKey(derived.ref)));
    expect(within(screen.getByRole('menu', { name: 'rel-a · derived' })).getAllByRole('menuitem').map((row) => row.textContent)).toEqual(['Relationship item']);
  });
});

describe('what a right-click on an item does to the selection', () => {
  const graph = (state: ClientState): void => loadGraph(state, [node('a', 'n1'), node('a', 'n2'), node('a', 'n3')], [stored]);

  it('selects an item that is not selected, replacing what was selected, before the menu opens', () => {
    const state = createClientState();
    graph(state);
    act(() => state.presentation.select([nodeKey('n2')]));
    const { rightClick } = show(state);
    rightClick(rightClickOn('node', nodeKey('n1')));
    expect(selection(state)).toEqual([nodeKey('n1')]);
    rightClick(rightClickOn('relationship', edgeKey(stored.ref)));
    expect(selection(state)).toEqual([edgeKey(stored.ref)]);
  });

  it('selects an item when nothing was selected', () => {
    const state = createClientState();
    graph(state);
    const { rightClick } = show(state);
    rightClick(rightClickOn('node', nodeKey('n3')));
    expect(selection(state)).toEqual([nodeKey('n3')]);
  });

  it('keeps the selection when the item is selected, alone or among others, and the menu acts on that item', () => {
    const state = createClientState();
    graph(state);
    act(() => state.presentation.select([nodeKey('n1'), nodeKey('n2')]));
    const menus = createMenuRegistry();
    const run = vi.fn();
    menus.register('node', { id: 'acts', label: 'Acts', icon: null, group: 10, order: 10, run });
    const { rightClick } = show(state, {}, menus);
    rightClick(rightClickOn('node', nodeKey('n2')));
    expect(selection(state)).toEqual([nodeKey('n1'), nodeKey('n2')].sort());
    act(() => void screen.getByRole('menuitem', { name: 'Acts' }).click());
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ kind: 'node', key: nodeKey('n2'), selection: [nodeKey('n1'), nodeKey('n2')] });
  });

  it('leaves the selection as it was on empty canvas', () => {
    const state = createClientState();
    graph(state);
    act(() => state.presentation.select([nodeKey('n1')]));
    const { rightClick } = show(state);
    rightClick(onCanvas(5, 5));
    expect(selection(state)).toEqual([nodeKey('n1')]);
  });

  it('hands a canvas command no key, and the selection at the moment it runs', async () => {
    const state = createClientState();
    graph(state);
    const menus = createMenuRegistry();
    const run = vi.fn();
    menus.register('canvas', { id: 'acts', label: 'Acts', icon: null, group: 10, order: 10, run });
    const { rightClick } = show(state, {}, menus);
    rightClick(onCanvas(5, 5));
    act(() => state.presentation.select([nodeKey('n3')]));
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Acts' }));
    expect(run.mock.calls[0]?.[0]).toMatchObject({ kind: 'canvas', key: undefined, selection: [nodeKey('n3')] });
  });

  it('opens nothing and changes nothing for a right-click on an item that is not loaded', () => {
    const state = createClientState();
    graph(state);
    act(() => state.presentation.select([nodeKey('n1')]));
    const { rightClick } = show(state);
    rightClick(rightClickOn('node', nodeKey('missing')));
    rightClick(rightClickOn('relationship', edgeKey({ sourceId: 'a', stableId: 'missing' })));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(selection(state)).toEqual([nodeKey('n1')]);
    expect(state.presentation.view.getState().openMenu).toBeUndefined();
  });

  it('closes the menu when the item it is about is no longer loaded', () => {
    const state = createClientState();
    graph(state);
    const { rightClick } = show(state);
    rightClick(rightClickOn('node', nodeKey('n3')));
    expect(screen.queryByRole('menu', { name: 'n3' })).not.toBeNull();
    act(() => state.setLoaded([key('a')], [end('n1'), end('n2')], [stored.ref]));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(state.presentation.view.getState().openMenu).toBeUndefined();
  });
});

describe('submenus, disabled items and locked items', () => {
  const ordinary = (id: string, extra: CommandOptions = {}): MenuItem => commandItem(id, extra);
  const parent = (id: string, content: ComponentType<SubmenuProps>, order: number, state?: MenuItemState): MenuItem => ({ id, label: id, icon: null, group: 10, order, submenu: content, ...(state === undefined ? {} : { state }) });
  const menusWith = (...items: MenuItem[]): MenuRegistry => {
    const registry = createMenuRegistry();
    for (const item of items) registry.register('canvas', item);
    return registry;
  };
  const Probe = ({ context, close }: SubmenuProps) => (
    <div>
      <p>{`probe for ${context.kind}`}</p>
      <button type="button" onClick={close}>
        Close everything
      </button>
    </div>
  );
  const openMenuWith = (registry: MenuRegistry, edition: 'community' | 'enterprise' | undefined = 'community') => {
    const state = createClientState();
    load(state);
    const view = show(state, {}, registry, edition);
    view.rightClick(onCanvas(10, 10));
    return { state, ...view };
  };

  it('shows a chevron and no shortcut on a submenu item, and opens its content beside it when it is pressed, with the context and a close that closes the whole menu', async () => {
    openMenuWith(menusWith(parent('Layout', Probe, 10)));
    const row = screen.getByRole('menuitem', { name: 'Layout' });
    expect(row.querySelector('.icon-chevron')).not.toBeNull();
    expect(row.querySelector('.menu-hint')).toBeNull();
    expect(row.getAttribute('aria-haspopup')).toBe('menu');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    const user = userEvent.setup();
    await user.click(row);
    expect(screen.getByText('probe for canvas')).not.toBeNull();
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryAllByRole('menu')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Close everything' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens the content when the pointer enters the row, and closes it when the pointer enters another row', async () => {
    openMenuWith(menusWith(parent('Layout', Probe, 10), ordinary('Plain', { order: 20 })));
    const user = userEvent.setup();
    await user.hover(screen.getByRole('menuitem', { name: 'Layout' }));
    expect(screen.queryByText('probe for canvas')).not.toBeNull();
    await user.hover(screen.getByRole('menuitem', { name: 'Plain' }));
    expect(screen.queryByText('probe for canvas')).toBeNull();
  });

  it('keeps one submenu at most: another submenu row takes the place of the first', async () => {
    const Other = () => <p>other content</p>;
    openMenuWith(menusWith(parent('First', Probe, 10), parent('Second', Other, 20)));
    const user = userEvent.setup();
    await user.click(screen.getByRole('menuitem', { name: 'First' }));
    await user.click(screen.getByRole('menuitem', { name: 'Second' }));
    expect(screen.queryByText('probe for canvas')).toBeNull();
    expect(screen.queryByText('other content')).not.toBeNull();
  });

  it('opens a submenu to the left of its row when it would leave the window on the right', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function measured(this: Element) {
      const own = this.classList.contains('context-submenu') ? { left: 0, top: 0, width: 150, height: 90 } : this.getAttribute('role') === 'menuitem' ? { left: 500, top: 100, width: 200, height: 30 } : { left: 0, top: 0, width: 0, height: 0 };
      return { ...own, x: own.left, y: own.top, right: own.left + own.width, bottom: own.top + own.height, toJSON: () => ({}) };
    });
    openMenuWith(menusWith(parent('Layout', Probe, 10)));
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Layout' }));
    const holder = screen.getByText('probe for canvas').closest('.context-submenu');
    expect(holder instanceof HTMLElement ? holder.style.left : '').toBe(`${500 - 6 - 150}px`);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  });

  it('does nothing when a disabled item is pressed or hovered, keeps the menu open and marks the item', async () => {
    const run = vi.fn();
    openMenuWith(menusWith(ordinary('Unavailable', { state: 'disabled', run })));
    const row = screen.getByRole('menuitem', { name: 'Unavailable' });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    const user = userEvent.setup();
    await user.hover(row);
    await user.click(row);
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it.each<['community' | 'enterprise', boolean]>([['community', true], ['enterprise', false]])('draws a locked item inert with the shared tag only in the edition that shows it (%s)', async (edition, tagged) => {
    const run = vi.fn();
    openMenuWith(menusWith(ordinary('Ask', { state: 'locked', lock: true, run })), edition);
    const row = screen.getByRole('menuitem', { name: new RegExp(`^Ask`) });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.querySelector('.menu-tag')?.textContent ?? null).toBe(tagged ? LOCK_TOOLTIP : null);
    expect(row.querySelector('.icon-lock')).not.toBeNull();
    await userEvent.setup().click(row);
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('draws no lock on a locked item that did not ask for one', () => {
    openMenuWith(menusWith(ordinary('Summarize', { state: 'locked' })));
    expect(screen.getByRole('menuitem', { name: /Summarize/ }).querySelector('.icon-lock')).toBeNull();
  });

  it.each<MenuItemState>(['disabled', 'locked'])('never opens the content of a %s submenu item, by press or by pointer', async (state) => {
    openMenuWith(menusWith(parent('Layout', Probe, 10, state)));
    const row = screen.getByRole('menuitem', { name: /Layout/ });
    const user = userEvent.setup();
    await user.hover(row);
    await user.click(row);
    expect(screen.queryByText('probe for canvas')).toBeNull();
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('closes a submenu whose content throws, and a sibling command still runs and shows its effect', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Broken = (): never => {
      throw new Error('cannot draw the submenu');
    };
    const { state } = openMenuWith(menusWith(parent('Broken', Broken, 10), ordinary('Select all', { order: 20, run: (context) => context.state.presentation.select([nodeKey('n1')]) })));
    const user = userEvent.setup();
    await user.click(screen.getByRole('menuitem', { name: 'Broken' }));
    expect(screen.getByRole('menuitem', { name: 'Broken' }).getAttribute('aria-expanded')).toBe('false');
    await user.click(screen.getByRole('menuitem', { name: 'Select all' }));
    expect(selection(state)).toEqual([nodeKey('n1')]);
  });
});

describe('the menu replaced, cleared and pressed outside', () => {
  it('clears only the menu whose item went away: another component opening a menu from a layout effect of the same commit keeps it', () => {
    const state = createClientState();
    loadGraph(state, [node('a', 'n1'), node('a', 'n2')], []);
    function Replacer() {
      const graph = useLoadedGraph();
      useLayoutEffect(() => {
        const open = state.presentation.view.getState().openMenu;
        if (open?.kind === 'node' && !graph.nodes.some((candidate) => elementKey(candidate.ref) === open.key)) state.presentation.setOpenMenu({ kind: 'canvas', key: undefined, x: 40, y: 50 });
      });
      return null;
    }
    const { rightClick } = show(state, {}, withBuiltIns(), 'community', <Replacer />);
    rightClick({ target: { kind: 'node', key: nodeKey('n2') }, x: 5, y: 5 });
    act(() => state.setLoaded([key('a')], [ref('a', 'type-a', 'n1')], []));
    expect(screen.getByRole('menu', { name: 'Canvas' })).not.toBeNull();
    expect(state.presentation.view.getState().openMenu).toMatchObject({ kind: 'canvas', x: 40, y: 50 });
  });

  it.each<[PointerTool, boolean, string[]]>([
    ['select', false, ['n2']],
    ['select', true, ['n1', 'n2']],
    ['pan', false, ['n1']],
    ['box', false, ['n2']],
  ])('closes on a press on the canvas in the mode %s (Shift: %s), changes no selection itself, and the click that follows does what it does in that mode', async (tool, shift, selected) => {
    const state = createClientState();
    load(state);
    act(() => {
      state.presentation.setTool(tool);
      state.presentation.select([nodeKey('n1')]);
    });
    const { factory, rightClick } = show(state);
    rightClick(onCanvas(10, 10));
    await userEvent.setup().pointer({ keys: '[MouseLeft>]', target: screen.getByRole('application', { name: 'Graph canvas' }) });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(selection(state)).toEqual([nodeKey('n1')]);
    act(() => factory.made[0]?.events[0]?.click({ target: nodeKey('n2'), shift }));
    expect(selection(state)).toEqual(selected.map(nodeKey).sort());
  });

  it('closes on a right press outside only when it is released and nothing replaced the menu', () => {
    vi.useFakeTimers();
    const state = createClientState();
    load(state);
    const { rightClick } = show(state);
    const outside = screen.getByRole('button', { name: 'Outside' });
    rightClick(onCanvas(10, 10));
    fireEvent.pointerDown(outside, { button: 2 });
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.pointerUp(outside, { button: 2 });
    expect(screen.queryByRole('menu')).not.toBeNull();
    act(() => void vi.runAllTimers());
    expect(screen.queryByRole('menu')).toBeNull();
    vi.useRealTimers();
  });

  it('closes on a left press outside at once', () => {
    const state = createClientState();
    load(state);
    const { rightClick } = show(state);
    rightClick(onCanvas(10, 10));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }), { button: 0 });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps a menu that a right press outside replaced, and returns the focus to the element that had it before the first menu', () => {
    vi.useFakeTimers();
    const state = createClientState();
    load(state);
    const { rightClick } = show(state);
    const canvas = screen.getByRole('application', { name: 'Graph canvas' });
    const outsider = document.createElement('button');
    document.body.append(outsider);
    act(() => outsider.focus());
    rightClick(onCanvas(10, 10));
    fireEvent.pointerDown(canvas, { button: 2 });
    rightClick(onCanvas(200, 300));
    fireEvent.pointerUp(canvas, { button: 2 });
    act(() => void vi.runAllTimers());
    expect(placeOf()).toEqual({ left: '208px', top: '308px' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(outsider);
    outsider.remove();
    vi.useRealTimers();
  });
});
