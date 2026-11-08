import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphEdge, GraphNode } from '@neburyx/contracts';
import { createClientState, type ClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { edge, node } from '../state/test-data.js';
import { clientWith, me, renderApp, source, stubFactory } from '../test-utils.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { registerBuiltInTools } from '../workspace/built-in-tools.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { PanelError, createPanelRegistryFor, type PanelRegistry } from '../workspace/panel-registry.js';
import { createSlotRegistry } from '../workspace/slots.js';
import { createToolRegistry } from '../workspace/tool-registry.js';
import { inputOf } from './panel-test-kit.js';
import { SEARCH_PANEL_ID } from './search-panel-binder.js';
import { registerSearchTool } from './search-tool.js';

const failing = vi.hoisted(() => ({ on: false }));
vi.mock('./on-canvas.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./on-canvas.js')>();
  return {
    ...original,
    findOnCanvas: (...given: Parameters<typeof original.findOnCanvas>) => {
      if (failing.on) throw new Error('the matching failed');
      return original.findOnCanvas(...given);
    },
  };
});

const client = clientWith({ me: me(), sources: [source('a')] });

afterEach(() => {
  failing.on = false;
  cleanup();
});

const titled = (stableId: string, title: string): GraphNode => ({ ...node('a', stableId), display: { title, type: 'type-a' } });

async function workspace(nodes: readonly GraphNode[] = [titled('ACC-48291', 'Review required'), titled('ACC-71825', 'Active')], edges: readonly GraphEdge[] = [edge('a', 'REL-1', 'ACC-48291', 'ACC-71825')], api = client) {
  const state: ClientState = createClientState();
  loadGraph(state, nodes, edges);
  const factory = stubFactory();
  const slots = createSlotRegistry();
  registerBuiltInSlots(slots);
  const tools = createToolRegistry();
  registerBuiltInTools(tools);
  registerSearchTool(tools, state);
  const panels: PanelRegistry = createPanelRegistryFor(state);
  const view = renderApp('/explore', api, state, slots, factory.create, undefined, tools, undefined, panels);
  await act(async () => void (await Promise.resolve()));
  return { state, panels, factory, view, user: userEvent.setup() };
}

const panelsOf = (panels: PanelRegistry): string[] => panels.view.getState().map((panel) => panel.id);
const searchTool = (): HTMLElement => screen.getByRole('button', { name: 'Search' });
const box = (): HTMLElement => screen.getByRole('searchbox', { name: 'Find on canvas' });

describe('the Search tool and its panel', () => {
  it('puts the tool in the strip after Explore, and opens a panel with a tab list on a press, and takes the panel out on the next', async () => {
    const { panels, user } = await workspace();
    const names = within(screen.getByRole('group', { name: 'Tools' })).getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual(['Explore', 'Search']);
    expect(panelsOf(panels)).toEqual([]);
    await user.click(searchTool());
    expect(panelsOf(panels)).toEqual([SEARCH_PANEL_ID]);
    expect(screen.getByRole('tablist', { name: 'Search' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Search' })).toBeDefined();
    await user.click(searchTool());
    expect(panelsOf(panels)).toEqual([]);
    expect(screen.queryByRole('tablist', { name: 'Search' })).toBeNull();
  });

  it('takes the panel out with its close control, and gives the focus back to the tool', async () => {
    const { panels, user } = await workspace();
    await user.click(searchTool());
    await user.click(screen.getByRole('button', { name: 'Close Search' }));
    expect(panelsOf(panels)).toEqual([]);
    expect(document.activeElement).toBe(searchTool());
  });

  const explore = (): HTMLElement => screen.getByRole('button', { name: 'Explore' });

  it('draws the tool active, and the pointer tool not, exactly while the panel is open, as frame 04i does', async () => {
    const { user } = await workspace();
    expect(searchTool().dataset['active']).toBeUndefined();
    expect(searchTool().getAttribute('aria-pressed')).toBe('false');
    expect(explore().dataset['active']).toBe('true');
    await user.click(searchTool());
    expect(searchTool().dataset['active']).toBe('true');
    expect(searchTool().getAttribute('aria-pressed')).toBe('true');
    expect(explore().dataset['active']).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'Close Search' }));
    expect(searchTool().dataset['active']).toBeUndefined();
    expect(searchTool().getAttribute('aria-pressed')).toBe('false');
    expect(explore().dataset['active']).toBe('true');
  });

  it('draws the tool active when the key opens the panel, keeps it while the key asks again, and draws the pointer tool active again on Escape', async () => {
    const { state, panels, user } = await workspace();
    act(() => state.presentation.requestSearch());
    expect(panelsOf(panels)).toEqual([SEARCH_PANEL_ID]);
    expect(searchTool().dataset['active']).toBe('true');
    expect(explore().dataset['active']).toBeUndefined();
    act(() => state.presentation.requestSearch());
    expect(searchTool().dataset['active']).toBe('true');
    await user.keyboard('{Escape}');
    expect(panelsOf(panels)).toEqual([]);
    expect(searchTool().dataset['active']).toBeUndefined();
    expect(explore().dataset['active']).toBe('true');
  });

  it('opens and closes the panel from the tool by the keyboard, with the tool active only while it is open', async () => {
    const { panels, user } = await workspace();
    searchTool().focus();
    await user.keyboard('{Enter}');
    expect(panelsOf(panels)).toEqual([SEARCH_PANEL_ID]);
    expect(searchTool().dataset['active']).toBe('true');
    searchTool().focus();
    await user.keyboard(' ');
    expect(panelsOf(panels)).toEqual([]);
    expect(searchTool().dataset['active']).toBeUndefined();
    expect(explore().dataset['active']).toBe('true');
  });

  it('keeps the tool active while the panel is collapsed to its bar, which is still open', async () => {
    const { user } = await workspace();
    await user.click(searchTool());
    await user.click(screen.getByRole('button', { name: 'Collapse Search' }));
    expect(searchTool().dataset['active']).toBe('true');
    expect(explore().dataset['active']).toBeUndefined();
  });

  it('focuses the box when the panel opens, and closes the panel on Escape inside it with the focus back on the tool', async () => {
    const { panels, user } = await workspace();
    await user.click(searchTool());
    expect(document.activeElement).toBe(box());
    await user.keyboard('{Escape}');
    expect(panelsOf(panels)).toEqual([]);
    expect(document.activeElement).toBe(searchTool());
  });

  it('counts and lists only the entities that are drawn, so a hidden one is neither found on the canvas nor counted', async () => {
    const { state, user } = await workspace();
    await user.click(searchTool());
    act(() => state.hide([elementKey(node('a', 'ACC-48291').ref)]));
    expect(screen.getByRole('tab', { name: 'On canvas · 1' })).toBeDefined();
    await user.type(box(), 'acc');
    expect(screen.queryByRole('button', { name: /ACC-48291/ })).toBeNull();
    act(() => state.presentation.showAllHidden());
    expect(screen.getByRole('tab', { name: 'On canvas · 2' })).toBeDefined();
  });

  it('shows the number of entities drawn on the first tab, and follows the graph as an entity is loaded', async () => {
    const { state, user } = await workspace();
    await user.click(searchTool());
    const tab = screen.getByRole('tab', { name: 'On canvas · 2' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    const shown = state.investigation.getState();
    const added = titled('ACC-99999', 'New');
    const [first] = shown.resultKeys;
    if (first === undefined) throw new Error('nothing is loaded');
    const addKey = { ...first, params: 'added' };
    act(() => {
      state.putResult(addKey, { sourceId: 'a', nodes: [added], edges: [] });
      state.setLoaded([...shown.resultKeys, addKey], [...shown.nodeRefs, added.ref], [...shown.edgeRefs]);
    });
    expect(screen.getByRole('tab', { name: 'On canvas · 3' })).toBeDefined();
    await user.type(box(), 'acc');
    expect(screen.getByRole('tab', { name: 'On canvas · 3' })).toBeDefined();
  });

  it('shows the hint for an empty box and "No loaded item matches." for a text nothing contains, as statuses', async () => {
    const { user } = await workspace();
    await user.click(searchTool());
    expect(screen.getByText('Type part of a title, type or ID.')).toBeDefined();
    await user.type(box(), 'zzz');
    expect(screen.getByText('No loaded item matches.').getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists the items that contain the text, makes no request and moves no entity, and selects and centres exactly the item that is chosen, with the choice announced and the focus on the row', async () => {
    const calls = { count: 0 };
    const guarded = new Proxy(clientWith({ me: me(), sources: [source('a')] }), { get: (target, name) => (name === 'searchEntities' || name === 'getEntity' ? () => (calls.count += 1) : Reflect.get(target, name)) });
    const { state, factory, user } = await workspace(undefined, [], guarded);
    await user.click(searchTool());
    act(() => state.presentation.setPositions(new Map([[elementKey(node('a', 'ACC-48291').ref), { x: 10, y: 20 }]])));
    const before = new Map(state.presentation.view.getState().positions);
    await user.type(box(), '71825');
    const row = screen.getByRole('button', { name: /ACC-71825/ });
    await user.click(row);
    expect([...state.presentation.view.getState().selection]).toEqual([elementKey(node('a', 'ACC-71825').ref)]);
    expect(screen.getByText('Selected Active.')).toBeDefined();
    expect(document.activeElement).toBe(row);
    expect(state.presentation.view.getState().positions).toEqual(before);
    expect(factory.made[0]?.centered).toEqual([elementKey(node('a', 'ACC-71825').ref)]);
    expect(calls.count).toBe(0);
  });

  it('drops the typed text when the investigation changes, and keeps the panel open', async () => {
    const { state, user } = await workspace();
    await user.click(searchTool());
    await user.type(box(), 'acc');
    expect(inputOf(box()).value).toBe('acc');
    act(() => {
      state.show({ id: 'inv-2', sourceId: 'a', record: { title: 'Another', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
    });
    expect(inputOf(box()).value).toBe('');
    expect(screen.getByRole('tablist', { name: 'Search' })).toBeDefined();
  });

  it('drops the typed text, the rows and the selection note of the On canvas tab when the mask changes', async () => {
    const { state, user } = await workspace();
    await user.click(searchTool());
    await user.type(box(), 'acc');
    await user.click(screen.getAllByRole('button', { name: /ACC-48291/ })[0] ?? searchTool());
    expect(screen.getByText(/^Selected /)).toBeDefined();
    act(() => state.setMask(true));
    expect(inputOf(box()).value).toBe('');
    expect(screen.queryByText(/^Selected /)).toBeNull();
  });

  it('drops the typed text of the On canvas tab when the source changes', async () => {
    const { state, user } = await workspace();
    await user.click(searchTool());
    await user.type(box(), 'acc');
    act(() => {
      state.show({ id: 'inv-b', sourceId: 'b', record: { title: 'Another', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
    });
    expect(inputOf(box()).value).toBe('');
  });

  it('expands a collapsed panel and focuses its box when the key asks for it', async () => {
    const { state, user } = await workspace();
    await user.click(searchTool());
    await user.click(screen.getByRole('button', { name: 'Collapse Search' }));
    expect(screen.getByRole('button', { name: 'Expand Search' })).toBeDefined();
    act(() => state.presentation.requestSearch());
    expect(screen.getByRole('button', { name: 'Collapse Search' })).toBeDefined();
    expect(document.activeElement).toBe(box());
  });

  it('closes the panel on Escape pressed on a control of the panel frame, collapsed or not', async () => {
    const { panels, user } = await workspace();
    await user.click(searchTool());
    screen.getByRole('button', { name: 'Collapse Search' }).focus();
    await user.keyboard('{Escape}');
    expect(panelsOf(panels)).toEqual([]);
    await user.click(searchTool());
    await user.click(screen.getByRole('button', { name: 'Collapse Search' }));
    screen.getByRole('button', { name: 'Expand Search' }).focus();
    await user.keyboard('{Escape}');
    expect(panelsOf(panels)).toEqual([]);
  });

  it('shows its own message when the panel throws while drawing, and leaves the canvas as it was', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { factory, user } = await workspace();
    await user.click(searchTool());
    const drawn = factory.made[0]?.scenes.length;
    failing.on = true;
    await user.type(box(), 'a');
    failing.on = false;
    expect(screen.getByRole('alert').textContent).toContain('Search');
    expect(screen.queryByRole('searchbox', { name: 'Find on canvas' })).toBeNull();
    expect(factory.made[0]?.scenes.length).toBe(drawn);
    expect(searchTool()).toBeDefined();
    spy.mockRestore();
  });

  it('is a panel of the host: it collapses to a bar and opens again, and reaches the tab and the box by Tab', async () => {
    const { user } = await workspace();
    await user.click(searchTool());
    await user.click(screen.getByRole('button', { name: 'Collapse Search' }));
    expect(screen.getByRole('button', { name: 'Expand Search' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Expand Search' }));
    expect(screen.getByRole('searchbox', { name: 'Find on canvas' })).toBeDefined();
    screen.getByRole('button', { name: 'Close Search' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /On canvas/ }));
    await user.tab();
    expect(document.activeElement).toBe(box());
  });

  it('refuses a second panel under the same ID, as every panel does', () => {
    const state = createClientState();
    const panels = createPanelRegistryFor(state);
    panels.register({ id: SEARCH_PANEL_ID, title: 'Search', placement: { kind: 'floating', side: 'left', top: 64 }, content: () => null });
    expect(() => panels.register({ id: SEARCH_PANEL_ID, title: 'Search', placement: { kind: 'floating', side: 'left', top: 64 }, content: () => null })).toThrow(PanelError);
  });
});
