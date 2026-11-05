import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { Toggles } from './legend-toggle.js';
import { createSlotRegistry } from './slots.js';

const client = clientWith({ me: me(), sources: [source('a')] });

function shown() {
  const slots = createSlotRegistry();
  slots.register('toggles', Toggles);
  const state = createClientState();
  const rendered = renderApp('/explore', client, state, slots);
  return { ...rendered, state };
}

const toggle = () => screen.getByRole('button', { name: 'Legend' });
const close = () => screen.getByRole('button', { name: 'Close Legend' });
const legend = () => screen.getByRole('complementary', { name: 'Legend' });

describe('the close button of the legend', () => {
  it('is named Close Legend, in the heading row, is reached with Tab and operated with Enter and Space, and sends the focus to the toggle', async () => {
    const { state } = shown();
    fireEvent.click(toggle());
    expect(within(legend()).getByRole('heading', { name: 'Legend' }).parentElement).toBe(close().parentElement);
    const user = userEvent.setup();
    for (let step = 0; step < 40 && document.activeElement !== close(); step += 1) await user.tab();
    expect(document.activeElement).toBe(close());
    await user.keyboard('{Enter}');
    expect(state.presentation.view.getState().legendOpen).toBe(false);
    expect(screen.queryByRole('complementary', { name: 'Legend' })).toBeNull();
    expect(document.activeElement).toBe(toggle());
    fireEvent.click(toggle());
    close().focus();
    await user.keyboard(' ');
    expect(state.presentation.view.getState().legendOpen).toBe(false);
    expect(document.activeElement).toBe(toggle());
  });

  it('closes the legend when pressed with the pointer, and leaves the toggle closed', () => {
    shown();
    fireEvent.click(toggle());
    fireEvent.click(close());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('is not shown while the legend\'s panel is collapsed, because the host hides a collapsed panel\'s content', () => {
    shown();
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Legend' }));
    expect(screen.queryByRole('button', { name: 'Close Legend' })).toBeNull();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });
});

describe('closing the legend', () => {
  it('from the toggle while its panel is collapsed takes the panel out, keeps its stored size, clears only its collapsed state, and the next open is expanded at that size', () => {
    const { state } = shown();
    fireEvent.click(toggle());
    act(() => state.presentation.setPanelSize('legend', 400));
    act(() => state.presentation.setPanelSize('other', 300));
    act(() => state.presentation.setPanelCollapsed('other', 9, true));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Legend' }));
    expect(state.presentation.view.getState().collapsedPanels.size).toBe(2);
    fireEvent.click(toggle());
    const after = state.presentation.view.getState();
    expect([...after.collapsedPanels]).toEqual([['other', 9]]);
    expect(after.panelSizes.get('legend')).toBe(400);
    expect(after.panelSizes.get('other')).toBe(300);
    fireEvent.click(toggle());
    expect(legend().style.width).toBe('400px');
    expect(screen.getByRole('button', { name: 'Collapse Legend' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('from the heading\'s button while expanded does the same and leaves other panels\' state', () => {
    const { state } = shown();
    fireEvent.click(toggle());
    act(() => state.presentation.setPanelSize('legend', 350));
    fireEvent.click(close());
    expect(state.presentation.view.getState().panelSizes.get('legend')).toBe(350);
    expect(state.presentation.view.getState().collapsedPanels.size).toBe(0);
  });

  it('is separate from collapsing: collapsing the panel does not close the legend, and the toggle still shows it open', () => {
    const { state } = shown();
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Legend' }));
    expect(state.presentation.view.getState().legendOpen).toBe(true);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });
});

describe('the legend\'s state, which is UI-only', () => {
  it('leaves the selection, the positions, the pins, the viewport and the tool as the objects they were, whichever control opens and closes it', () => {
    const { state } = shown();
    state.bindSource('a');
    const before = state.presentation.view.getState();
    fireEvent.click(toggle());
    fireEvent.click(close());
    const after = state.presentation.view.getState();
    for (const name of ['selection', 'positions', 'pins', 'viewport', 'panelSizes', 'tool'] as const) expect(Object.is(after[name], before[name]), name).toBe(true);
  });

  it('is kept when another source is bound, and the panel stays and shows the new source', () => {
    const { state } = shown();
    state.bindSource('a');
    fireEvent.click(toggle());
    act(() => state.bindSource('b'));
    expect(state.presentation.view.getState().legendOpen).toBe(true);
    expect(legend()).toBeTruthy();
  });
});

describe('the legend when the investigation page is left and opened again', () => {
  it('is shown again when it was open and stays closed when it was closed, with its state kept in between', async () => {
    const { router, state, panels, container } = shown();
    act(() => state.presentation.setLegendOpen(true));
    expect(container.querySelector('.legend-panel')).not.toBeNull();
    await act(async () => void (await router.navigate('/sources')));
    expect(container.querySelector('.legend-panel')).toBeNull();
    expect(state.presentation.view.getState().legendOpen).toBe(true);
    expect(panels.view.getState().map((panel) => panel.id)).toEqual(['legend']);
    await act(async () => void (await router.navigate('/explore')));
    expect(container.querySelector('.legend-panel')).not.toBeNull();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    act(() => state.presentation.setLegendOpen(false));
    await act(async () => void (await router.navigate('/sources')));
    await act(async () => void (await router.navigate('/explore')));
    expect(container.querySelector('.legend-panel')).toBeNull();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });
});
