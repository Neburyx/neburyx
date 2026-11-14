import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GraphEdge } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { edge, ref } from '../state/test-data.js';
import { filtersWorkspace, openFilters, typedNode } from './filters-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const nodes = [typedNode('n0', 'kind-a'), typedNode('n1', 'kind-b'), typedNode('n2', 'kind-a'), typedNode('n3', 'kind-b')];
const linked = (id: string, from: string, to: string, observedAt?: string): GraphEdge => ({
  ...edge('a', id, from, to),
  type: 'link-a',
  from: ref('a', 'kind-a', from),
  to: ref('a', 'kind-b', to),
  ...(observedAt === undefined ? {} : { observedAt }),
});
const recent = new Date().toISOString();
const edges = [linked('old', 'n0', 'n1', '2020-01-01'), linked('new', 'n2', 'n3', recent)];
const windowSelect = (): HTMLElement => screen.getByRole('combobox', { name: /· UTC$/ });

describe('the time window in the Filters panel', () => {
  it('is disabled and says why when no relationship type of the mapping has a time', async () => {
    await filtersWorkspace(nodes, undefined, edges, false);
    openFilters();
    await act(async () => void (await Promise.resolve()));
    expect((windowSelect() as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText('No relationship type in the mapping has a time')).toBeTruthy();
  });

  it('is disabled and says it is loading while the profile is not read', async () => {
    await filtersWorkspace(nodes, 'pending', edges);
    openFilters();
    expect((windowSelect() as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getAllByText('Loading types').length).toBeGreaterThan(0);
  });

  it('filters out the loaded items outside the chosen preset, says it applies to loaded items, and resets', async () => {
    const { state } = await filtersWorkspace(nodes, undefined, edges, true);
    openFilters();
    await act(async () => void (await Promise.resolve()));
    expect(screen.getByText('Applies to loaded items.')).toBeTruthy();
    await userEvent.selectOptions(windowSelect(), 'Last 30 days');
    expect(state.visibleGraph().edges.map((candidate) => candidate.ref)).toEqual([edges[1]?.ref]);
    expect(state.visibleGraph().nodes.map((candidate) => candidate.ref.stableId)).toEqual(['n2', 'n3']);
    await userEvent.click(screen.getByRole('button', { name: 'Reset time window' }));
    expect(state.visibleGraph().nodes).toHaveLength(4);
    expect(state.loadedGraph().nodes).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Reset time window' })).toBeNull();
  });

  it('says how many relationships without a time stay shown', async () => {
    const { state } = await filtersWorkspace(nodes, undefined, [linked('none', 'n0', 'n1'), linked('new', 'n2', 'n3', recent)], true);
    openFilters();
    await act(async () => void (await Promise.resolve()));
    await userEvent.selectOptions(windowSelect(), 'Last 7 days');
    expect(screen.getByText('1 relationship has no time and stays shown')).toBeTruthy();
    expect(state.visibleGraph().edges).toHaveLength(2);
  });

  it('is operable by keyboard alone', async () => {
    const { state } = await filtersWorkspace(nodes, undefined, edges, true);
    openFilters();
    await act(async () => void (await Promise.resolve()));
    await userEvent.selectOptions(windowSelect(), 'Last 7 days');
    expect(state.presentation.view.getState().typeFilter.time?.window).toEqual({ days: 7 });
    screen.getByRole('button', { name: 'Reset time window' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(state.presentation.view.getState().typeFilter.time).toBeUndefined();
  });

  it('takes dates, filters by them, and sets nothing for reversed dates or bad days', async () => {
    const { state } = await filtersWorkspace(nodes, undefined, edges, true);
    openFilters();
    await act(async () => void (await Promise.resolve()));
    const time = (): unknown => state.presentation.view.getState().typeFilter.time?.window;
    await userEvent.selectOptions(windowSelect(), 'Other number of days');
    await userEvent.type(screen.getByRole('textbox', { name: 'Days' }), '0');
    expect(screen.getByRole('alert').textContent).toBe('Enter a whole number of days from 1 to 3650.');
    expect(time()).toBeUndefined();
    await userEvent.selectOptions(windowSelect(), 'Dates (UTC)');
    await userEvent.type(screen.getByRole('textbox', { name: 'From (UTC date)' }), '2026-10-28');
    await userEvent.type(screen.getByRole('textbox', { name: 'To (UTC date)' }), '2026-10-21');
    expect(screen.getByRole('alert').textContent).toBe('Before the start date');
    expect(time()).toBeUndefined();
    await userEvent.clear(screen.getByRole('textbox', { name: 'To (UTC date)' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'To (UTC date)' }), '2026-10-30');
    expect(time()).toEqual({ from: '2026-10-28', to: '2026-10-30' });
    expect(state.visibleGraph().edges).toHaveLength(0);
  });

  it('is named after the time property of the mapping when every dated row names the same one, and generically when they differ or none is dated', async () => {
    await filtersWorkspace(nodes, undefined, edges, true);
    openFilters();
    await act(async () => void (await Promise.resolve()));
    expect(screen.getByRole('combobox', { name: 'seen_at · UTC' })).toBeTruthy();
    cleanup();
    document.body.replaceChildren();
    await filtersWorkspace(nodes, undefined, edges, 'differing');
    openFilters();
    await act(async () => void (await Promise.resolve()));
    expect(screen.getByRole('combobox', { name: 'Time window · UTC' })).toBeTruthy();
  });
});
