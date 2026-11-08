import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { elementKey } from '../state/keys.js';
import { createClientState } from '../state/client-state.js';
import { edge, ref } from '../state/test-data.js';
import { loadGraph } from './context-menu-kit.js';
import { registerBuiltInMenuItems } from './built-in-menu-items.js';
import { filtersWorkspace, openFilters, typedNode } from './filters-kit.js';
import { createMenuRegistry, stateOf, type MenuContext } from './menu-registry.js';
import { filterResultLine, relationshipResultLine } from './scope-text.js';
import { deriveLoadedGraph } from '../state/loaded-graph.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const ten = [...Array.from({ length: 7 }, (_unused, at) => typedNode(`n${at}`, 'kind-a')), ...Array.from({ length: 3 }, (_unused, at) => typedNode(`n${at + 7}`, 'kind-b'))];
const keyOf = (id: string, type: string): string => elementKey(ref('a', type, id));
const scopeLines = (): string[] => within(screen.getByRole('group', { name: 'Graph scope' })).getAllByText(/./).map((line) => line.textContent ?? '');
const resultLine = (): string => (document.querySelector('.filters-panel [role="status"] p:first-child')?.textContent ?? '');

describe('the lines when types are off', () => {
  it('count 3 of 10 entities hidden by filters, show 7, change nothing of the rest, and make no request', async () => {
    const { state } = await filtersWorkspace(ten);
    openFilters();
    await userEvent.click(screen.getByRole('button', { name: 'KIND-B' }));
    expect(resultLine()).toBe('7 of 10 match · exact · 3 hidden');
    expect(scopeLines()[0]).toContain('10 entities');
    expect(scopeLines()[0]).toContain(' · 3 hidden by filters');
    expect(scopeLines().at(-1)).toBe('7 shown · more not yet retrieved');
    expect(state.loadedGraph().entities.value).toBe(10);
  });

  it('never count an entity twice that is hidden by hand and filtered', async () => {
    const { state } = await filtersWorkspace(ten);
    act(() => state.hide([keyOf('n7', 'kind-b'), keyOf('n0', 'kind-a')]));
    openFilters();
    await userEvent.click(screen.getByRole('button', { name: 'KIND-B' }));
    expect(scopeLines()[0]).toContain('2 hidden from view');
    expect(scopeLines()[0]).toContain('2 hidden by filters');
    expect(scopeLines().at(-1)).toBe('6 shown · more not yet retrieved');
    expect(resultLine()).toBe('6 of 8 match · exact · 2 hidden');
    const menus = createMenuRegistry();
    registerBuiltInMenuItems(menus);
    const item = menus.view.getState().get('canvas')?.find((candidate) => candidate.id === 'show-hidden');
    const context: MenuContext = { kind: 'canvas', key: undefined, selection: [], state, canvas: undefined };
    expect(typeof item?.label === 'function' ? item.label(context) : item?.label).toBe('Show hidden entities (2)');
    expect(item === undefined ? undefined : stateOf(item, context)).toBe('enabled');
    act(() => state.presentation.showAllHidden());
    expect(scopeLines()[0]).toContain('3 hidden by filters');
    expect(scopeLines()[0]).not.toContain('hidden from view');
    expect(scopeLines().at(-1)).toBe('7 shown · more not yet retrieved');
    expect(resultLine()).toBe('7 of 10 match · exact · 3 hidden');
  });

  it('go back to the plain lines on Reset, and put the focus on the first chip', async () => {
    await filtersWorkspace(ten);
    openFilters();
    await userEvent.click(screen.getByRole('button', { name: 'KIND-B' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(scopeLines()).toEqual(['10 entities · 0 relationships · loaded · exact', '10 shown · more not yet retrieved']);
    expect(resultLine()).toBe('10 of 10 match · exact · 0 hidden');
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'KIND-A' }));
  });

  it('say nothing is loaded, and show no result line, when nothing is loaded', async () => {
    await filtersWorkspace([]);
    openFilters();
    expect(resultLine()).toBe('Nothing loaded yet.');
  });
});

describe('the result line', () => {
  it('counts out of the entities not hidden by hand, and reads 0 of 0 when every entity is', () => {
    const loaded = ['a', 'b', 'c'];
    expect(filterResultLine(loaded, new Set(), new Set(['c']))).toBe('2 of 3 match · exact · 1 hidden');
    expect(filterResultLine(loaded, new Set(['a', 'b', 'c']), new Set(['c']))).toBe('0 of 0 match · exact · 0 hidden');
    expect(filterResultLine([], new Set(), new Set())).toBeUndefined();
    expect(filterResultLine(loaded, new Set(['c']), new Set(['c']))).toBe('2 of 2 match · exact · 0 hidden');
  });
});

describe('the relationships line', () => {
  const link = (id: string, from: string, to: string, type: string) => ({ ...edge('a', id, from, to), type, from: ref('a', 'kind-a', from), to: ref('a', 'kind-a', to) });
  it('counts the relationships that can be drawn and touch no entity hidden by hand, once each, and is absent while no type is off', () => {
    const nodes = ['n0', 'n1', 'n2', 'n3'].map((id) => typedNode(id, 'kind-a'));
    const edges = [link('e0', 'n0', 'n1', 'link-a'), link('e1', 'n1', 'n2', 'link-b'), link('e2', 'n2', 'n3', 'link-a'), link('e3', 'n3', 'n0', 'link-b'), link('e4', 'n0', 'n9', 'link-a')];
    const state = createClientState();
    loadGraph(state, nodes, edges);
    const graph = deriveLoadedGraph(state.server.getState(), state.investigation.getState());
    const k = (id: string): string => elementKey(ref('a', 'kind-a', id));
    expect(relationshipResultLine(graph, new Set(), new Set(), new Set())).toBeUndefined();
    expect(relationshipResultLine(graph, new Set(), new Set(), new Set(['link-a']))).toBe('2 of 4 relationships match');
    expect(relationshipResultLine(graph, new Set([k('n3')]), new Set(), new Set(['link-a']))).toBe('1 of 2 relationships match');
    expect(relationshipResultLine(graph, new Set(), new Set([k('n1')]), new Set(['link-a']))).toBe('1 of 4 relationships match');
  });
});

describe('the lines with the neighborhood focus on and a type off', () => {
  it('count an entity both outside the focus and filtered once, as outside the focus', async () => {
    const nodes = [typedNode('n0', 'kind-a'), typedNode('n1', 'kind-c'), typedNode('n2', 'kind-c'), typedNode('n3', 'kind-b')];
    const link = { ...edge('a', 'e0', 'n0', 'n1'), from: ref('a', 'kind-a', 'n0'), to: ref('a', 'kind-c', 'n1') };
    const { state } = await filtersWorkspace(nodes);
    loadGraph(state, nodes, [link]);
    state.presentation.setMappedTypes({ entityTypes: ['kind-a', 'kind-b', 'kind-c'], relationshipTypes: [] });
    act(() => state.setEntityTypeOff('kind-c', true));
    act(() => state.focusOn(keyOf('n0', 'kind-a')));
    openFilters();
    expect(scopeLines()[0]).toContain('2 outside focus');
    expect(scopeLines()[0]).toContain('1 hidden by filters');
    expect(scopeLines().at(-1)).toBe('1 shown · more not yet retrieved');
    expect(resultLine()).toBe('1 of 2 match · exact · 1 hidden');
  });
});
