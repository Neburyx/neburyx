import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { edgeKey } from '../state/keys.js';
import { edge, node } from '../state/test-data.js';
import { item, load, loadGraph, menu, nodeKey, onCanvas, show } from './context-menu-kit.js';
import { LegendToggle } from './legend-toggle.js';

afterEach(cleanup);

const legendItem = (): HTMLElement => screen.getByRole('menuitem', { name: /legend/ });
const toggle = () => screen.getByRole('button', { name: 'Legend' });

describe('the Show legend item of the canvas menu', () => {
  it('sits after Layout in the group of Layout, reads Show legend with the hint L, and is an ordinary command row', () => {
    const state = createClientState();
    load(state);
    const { rightClick } = show(state);
    rightClick(onCanvas(10, 10));
    const rows = within(menu()).getAllByRole('menuitem');
    const names = rows.map((row) => row.querySelector('.menu-label')?.textContent);
    expect(names.indexOf('Show legend')).toBe(names.indexOf('Layout') + 1);
    expect(legendItem().textContent).toBe('Show legendL');
    expect(legendItem().getAttribute('aria-haspopup')).toBeNull();
    expect(within(menu()).queryAllByRole('separator')).toHaveLength(1);
  });

  it('opens the legend and closes the menu when chosen, and reads Hide legend the next time and closes the legend', async () => {
    const state = createClientState();
    load(state);
    const { rightClick } = show(state);
    rightClick(onCanvas(10, 10));
    await userEvent.setup().click(legendItem());
    expect(state.presentation.view.getState().legendOpen).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    rightClick(onCanvas(10, 10));
    expect(legendItem().querySelector('.menu-label')?.textContent).toBe('Hide legend');
    await userEvent.setup().click(legendItem());
    expect(state.presentation.view.getState().legendOpen).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
    rightClick(onCanvas(10, 10));
    expect(legendItem().querySelector('.menu-label')?.textContent).toBe('Show legend');
  });

  it('is enabled with no graph loaded and with no renderer commands, because it needs neither', async () => {
    const state = createClientState();
    load(state, []);
    const { rightClick } = show(state);
    rightClick(onCanvas(10, 10));
    expect(legendItem().getAttribute('aria-disabled')).toBeNull();
    await userEvent.setup().click(legendItem());
    expect(state.presentation.view.getState().legendOpen).toBe(true);
  });

  it('drives the same state the toggle shows: choosing it flips the toggle, and the toggle flips what the item reads', async () => {
    const state = createClientState();
    load(state);
    const { rightClick } = show(state, {}, undefined, <LegendToggle />);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    rightClick(onCanvas(10, 10));
    await userEvent.setup().click(legendItem());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    await userEvent.setup().click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    rightClick(onCanvas(10, 10));
    expect(legendItem().querySelector('.menu-label')?.textContent).toBe('Show legend');
  });

  it('is in the canvas menu only: the menus of an entity and of a relationship do not carry it', () => {
    const state = createClientState();
    const stored = edge('a', 'e-stored', 'n1', 'n2');
    loadGraph(state, [node('a', 'n1'), node('a', 'n2')], [stored]);
    const { rightClick } = show(state);
    rightClick({ target: { kind: 'node', key: nodeKey('n1') }, x: 10, y: 10 });
    expect(screen.getByRole('menu', { name: 'n1' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /legend/ })).toBeNull();
    rightClick({ target: { kind: 'relationship', key: edgeKey(stored.ref) }, x: 10, y: 10 });
    expect(screen.queryByRole('menuitem', { name: /legend/ })).toBeNull();
    rightClick(onCanvas(10, 10));
    expect(legendItem()).toBeTruthy();
  });

  it('changes nothing but the legend and the menu: the selection, positions, pins and viewport are the objects they were', async () => {
    const state = createClientState();
    load(state);
    state.presentation.select([nodeKey('n1')]);
    state.presentation.setViewport({ zoom: 2, x: 3, y: 4 });
    const { rightClick } = show(state);
    rightClick(onCanvas(10, 10));
    const before = state.presentation.view.getState();
    await userEvent.setup().click(legendItem());
    const after = state.presentation.view.getState();
    expect([after.legendOpen, before.legendOpen]).toEqual([true, false]);
    for (const name of ['selection', 'positions', 'pins', 'viewport', 'panelSizes', 'collapsedPanels', 'tool'] as const) expect(Object.is(after[name], before[name]), name).toBe(true);
  });
});
