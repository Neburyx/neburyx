import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { clientWith, me, need, renderApp, source } from '../test-utils.js';
import { Toggles } from './legend-toggle.js';
import { createSlotRegistry } from './slots.js';

const client = clientWith({ me: me(), sources: [source('a')] });

function shown() {
  const slots = createSlotRegistry();
  slots.register('toggles', Toggles);
  const rendered = renderApp('/explore', client, undefined, slots);
  return { ...rendered, slots };
}

const toggle = () => screen.getByRole('button', { name: 'Legend' });

describe('the legend toggle', () => {
  it('is a button named Legend, closed to begin with, holding the two samples the frame draws', () => {
    const { container } = shown();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().querySelector('.legend-toggle-sourced')?.textContent).toBe('— sourced');
    expect(toggle().querySelector('.legend-toggle-derived')?.textContent).toBe('- - rule-derived');
    expect(need(container.querySelector('.region-toggles'), 'the toggles region').contains(toggle())).toBe(true);
  });

  it('is alone in the bottom-left region when nothing occupies the table toggle slot, and follows the occupant when one does', () => {
    const { container, slots } = shown();
    const region = need(container.querySelector('.region-toggles'), 'the toggles region');
    expect([...region.children]).toEqual([toggle()]);
    act(() => {
      slots.register('table-toggle', () => <p>Table here</p>);
    });
    expect([...region.children].map((child) => child.textContent)).toEqual(['Table here', '— sourced- - rule-derived']);
    expect(region.lastElementChild).toBe(toggle());
  });

  it('opens the legend when pressed and closes it when pressed again, with the panel registered on the right of the canvas, 64 px down, 320 px wide', () => {
    const { state } = shown();
    expect(screen.queryByRole('complementary', { name: 'Legend' })).toBeNull();
    fireEvent.click(toggle());
    expect(state.presentation.view.getState().legendOpen).toBe(true);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('complementary', { name: 'Legend' });
    expect([panel.style.top, panel.style.right, panel.style.width]).toEqual(['64px', '16px', '320px']);
    fireEvent.click(toggle());
    expect(state.presentation.view.getState().legendOpen).toBe(false);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('complementary', { name: 'Legend' })).toBeNull();
  });

  it('is reached with Tab and operated with Enter and Space, keeps the focus after the press and does not hand it to the panel', async () => {
    shown();
    const user = userEvent.setup();
    for (let step = 0; step < 30 && document.activeElement !== toggle(); step += 1) await user.tab();
    expect(document.activeElement).toBe(toggle());
    await user.keyboard('{Enter}');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(toggle());
    expect(screen.getByRole('complementary', { name: 'Legend' }).contains(document.activeElement)).toBe(false);
    await user.keyboard(' ');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle());
  });

  it('shows the state of another way of opening the legend: the toggle follows `legendOpen`', () => {
    const { state } = shown();
    act(() => state.presentation.setLegendOpen(true));
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    act(() => state.presentation.setLegendOpen(false));
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });
});
