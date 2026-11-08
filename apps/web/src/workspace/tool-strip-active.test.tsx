import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { filtersWorkspace, openFilters } from './filters-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const strip = () => within(screen.getByRole('group', { name: 'Tools' }));
const button = (name: string): HTMLElement => strip().getByRole('button', { name });
const activeNames = (): string[] => strip().getAllByRole('button').filter((entry) => entry.getAttribute('data-active') === 'true').map((entry) => entry.getAttribute('aria-label') ?? '');

async function withSearch() {
  const parts = await filtersWorkspace();
  return parts;
}

describe('the tool strip with the Filters and Search panels', () => {
  it('closes Search when Filters opens and the other way, and draws only the open one active', async () => {
    const { state } = await withSearch();
    expect(activeNames()).toEqual(['Explore']);
    act(() => state.presentation.requestSearch());
    expect(state.presentation.view.getState()).toMatchObject({ searchOpen: true, filtersOpen: false });
    openFilters();
    expect(state.presentation.view.getState()).toMatchObject({ searchOpen: false, filtersOpen: true });
    expect(activeNames()).toEqual(['Filters']);
    act(() => state.presentation.requestSearch());
    expect(state.presentation.view.getState()).toMatchObject({ searchOpen: true, filtersOpen: false });
    expect(screen.queryByRole('group', { name: 'Entity types' })).toBeNull();
    expect(activeNames()).toEqual(['Search']);
  });

  it('closes Filters when Search is opened with its key, and keeps what Search was last showing', async () => {
    const { state } = await withSearch();
    act(() => state.presentation.setSearchTab('source'));
    openFilters();
    act(() => state.presentation.requestSearch());
    expect(state.presentation.view.getState()).toMatchObject({ searchOpen: true, filtersOpen: false, searchTab: 'source' });
  });

  it('draws only the flyout active while it is open over a panel, and the panel again when it closes', async () => {
    await withSearch();
    openFilters();
    expect(activeNames()).toEqual(['Filters']);
    await userEvent.click(button('Explore'));
    expect(activeNames()).toEqual(['Explore']);
    expect(button('Filters').getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Explore' }), { key: 'Escape' });
    expect(activeNames()).toEqual(['Filters']);
  });

  it('never has two buttons drawn active, and never gives a button both aria-pressed and aria-expanded', async () => {
    const { state } = await withSearch();
    const check = (): void => {
      expect(activeNames().length).toBeLessThanOrEqual(1);
      for (const entry of strip().getAllByRole('button')) expect(entry.hasAttribute('aria-pressed') && entry.hasAttribute('aria-expanded')).toBe(false);
    };
    check();
    openFilters();
    check();
    await userEvent.click(button('Explore'));
    check();
    act(() => state.presentation.requestSearch());
    check();
  });

  it('gives a flyout button aria-haspopup and aria-expanded, and a panel button aria-pressed and no aria-haspopup', async () => {
    await withSearch();
    const explore = button('Explore');
    expect([explore.getAttribute('aria-haspopup'), explore.getAttribute('aria-expanded'), explore.getAttribute('aria-pressed')]).toEqual(['menu', 'false', null]);
    await userEvent.click(explore);
    expect(explore.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(explore);
    const filters = button('Filters');
    expect([filters.getAttribute('aria-haspopup'), filters.getAttribute('aria-expanded'), filters.getAttribute('aria-pressed')]).toEqual([null, null, 'false']);
    openFilters();
    expect(filters.getAttribute('aria-pressed')).toBe('true');
  });

  it('tabs through the first chip, the other chips, Reset while a type is off, then the relationship checkboxes, and closes on Escape with the focus back on its button', async () => {
    await withSearch();
    openFilters();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'KIND-B' }));
    screen.getByRole('button', { name: 'KIND-A' }).focus();
    const seen: string[] = [];
    for (let at = 0; at < 8; at += 1) {
      seen.push(document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '');
      await user.tab();
    }
    expect(seen.slice(0, 6)).toEqual(['KIND-A', 'KIND-B', 'KIND-C', 'Reset', 'link-a', 'link-b']);
    fireEvent.keyDown(screen.getByRole('button', { name: 'KIND-A' }), { key: 'Escape' });
    expect(document.activeElement).toBe(button('Filters'));
  });
});

