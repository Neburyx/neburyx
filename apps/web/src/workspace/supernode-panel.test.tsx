import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createPresentationStore } from '../state/presentation-state.js';
import { ref } from '../state/test-data.js';
import { load, nodeKey } from './context-menu-kit.js';
import { stateOf } from './menu-registry.js';
import { bindLegend } from './legend-binder.js';
import { panel, panelRig } from './supernode-kit.js';

afterEach(() => cleanup());

describe('the entry Expand by type of the node menu', () => {
  it('is disabled for an item with no stable ID, and opens no panel', () => {
    const { menus, state } = panelRig();
    const item = menus.view.getState().get('node')?.find((entry) => entry.id === 'expand-by-type');
    expect(item).toBeDefined();
    if (item === undefined) return;
    const context = (key: string) => ({ kind: 'node' as const, key, selection: [], state, canvas: undefined });
    expect(stateOf(item, context('["node","a","type-a",""]'))).toBe('disabled');
    expect(stateOf(item, context(nodeKey('n1')))).toBe('enabled');
    expect(panel()).toBeNull();
  });

  it('opens the panel titled Expand relationships for the node, closes the menu, and puts the focus on the Relationship type', async () => {
    const { open } = panelRig();
    expect(panel()).toBeNull();
    await open();
    expect(panel()).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Expand relationships' })).not.toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByText(/^n1 · /)).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Relationship type' }));
  });

  it('shows the other node when it is chosen for another node, one panel at a time', async () => {
    const { open } = panelRig();
    await open('n1');
    await open('n2');
    expect(screen.getAllByRole('complementary', { name: 'Expand relationships' })).toHaveLength(1);
    expect(screen.getByText(/^n2 · /)).not.toBeNull();
    expect(screen.queryByText(/^n1 · /)).toBeNull();
  });

  it('closes with Escape and with Close, and gives the focus back to the canvas', async () => {
    const { open } = panelRig();
    const user = userEvent.setup();
    await open();
    await user.keyboard('{Escape}');
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('.graph-canvas'));
    await open();
    await user.click(screen.getByRole('button', { name: 'Close Expand relationships' }));
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('.graph-canvas'));
  });
});

describe('the place of the panel', () => {
  it('hangs from the left beside the tool strip, so the legend on the right and the panel are both there at once', async () => {
    const { open, state, panels } = panelRig();
    bindLegend(state, panels);
    act(() => state.presentation.setLegendOpen(true));
    await open();
    expect(panel()).not.toBeNull();
    expect(screen.getByRole('complementary', { name: 'Legend' })).not.toBeNull();
    const placement = panels.view.getState().find((entry) => entry.id === 'supernode')?.placement;
    expect(placement).toMatchObject({ kind: 'floating', side: 'left', inset: 72 });
    expect(panels.view.getState().find((entry) => entry.id === 'legend')?.placement).toMatchObject({ side: 'right' });
  });

  it('moves past the Search panel at the width it has, without being registered again, so what it holds stays', async () => {
    const { open, state, panels } = panelRig();
    await open();
    const entry = () => panels.view.getState().find((candidate) => candidate.id === 'supernode');
    const inset = () => (entry()?.placement as { inset?: number } | undefined)?.inset;
    const registration = entry()?.registration;
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Relationship type' }), 'link-a');
    await user.clear(screen.getByRole('spinbutton', { name: 'Page size per type' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Page size per type' }), '99');
    act(() => state.presentation.setSearchOpen(true));
    expect(inset()).toBe(72 + 300 + 16);
    act(() => state.presentation.setPanelSize('search', 400));
    expect(inset()).toBe(72 + 400 + 16);
    act(() => state.presentation.setSearchOpen(false));
    expect(inset()).toBe(72);
    expect(entry()?.registration).toBe(registration);
    expect((screen.getByRole('combobox', { name: 'Relationship type' }) as HTMLSelectElement).value).toBe('link-a');
    expect((screen.getByRole('spinbutton', { name: 'Page size per type' }) as HTMLInputElement).value).toBe('99');
    expect(state.presentation.view.getState().supernodePanel).toBeDefined();
  });

  it('does not take the focus when it moves', async () => {
    const { open, state } = panelRig();
    await open();
    const outside = document.createElement('input');
    document.body.append(outside);
    outside.focus();
    act(() => state.presentation.setSearchOpen(true));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe('the panel is about one node of one investigation under one masking setting', () => {
  it('closes when the masking changes', async () => {
    const { open, state } = panelRig();
    await open();
    act(() => state.setMask(true));
    expect(panel()).toBeNull();
    expect(state.presentation.view.getState().supernodePanel).toBeUndefined();
  });

  it('closes when the investigation changes, and when the node leaves the loaded graph', async () => {
    const { open, state } = panelRig();
    await open();
    act(() => state.bindSource('b'));
    expect(panel()).toBeNull();
    load(state, ['n1', 'n2']);
    await open('n2');
    expect(panel()).not.toBeNull();
    act(() => {
      state.setLoaded([...state.investigation.getState().resultKeys], [ref('a', 'type-a', 'n1')], []);
    });
    expect(panel()).toBeNull();
  });

  it('is cleared by reset of the presentation state, which keeps the legend, and refuses a node the investigation does not hold', () => {
    const store = createPresentationStore({ isNode: (key) => key === 'known', isElement: (key) => key === 'known' });
    store.setLegendOpen(true);
    store.setSupernodePanel({ key: 'known' });
    store.reset();
    expect(store.view.getState().supernodePanel).toBeUndefined();
    expect(store.view.getState().legendOpen).toBe(true);
    expect(() => store.setSupernodePanel({ key: 'missing' })).toThrow();
  });

  it('is not saved with a view: the snapshot of the presentation state does not hold it', () => {
    const store = createPresentationStore({ isNode: () => true, isElement: () => true });
    store.setSupernodePanel({ key: 'known' });
    expect(Object.keys(store.snapshot())).not.toContain('supernodePanel');
  });
});
