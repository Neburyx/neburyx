import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GraphEdge } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { drawnKeys } from '../state/loaded-graph.js';
import { edge, ref } from '../state/test-data.js';
import { filtersWorkspace, openFilters, typedNode } from './filters-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const nodes = [typedNode('n0', 'kind-a'), typedNode('n1', 'kind-b'), typedNode('n2', 'kind-a'), typedNode('n3', 'kind-b'), typedNode('lone', 'kind-a')];
const linked = (id: string, from: string, to: string, observedAt: string): GraphEdge => ({ ...edge('a', id, from, to), type: 'link-a', from: ref('a', 'kind-a', from), to: ref('a', 'kind-b', to), observedAt });
const edges = [linked('old', 'n0', 'n1', '2020-01-01'), linked('new', 'n2', 'n3', new Date().toISOString())];
const scopeLines = (): string[] => within(screen.getByRole('group', { name: 'Graph scope' })).getAllByText(/./).map((line) => line.textContent ?? '');
const statusLines = (): string[] => [...document.querySelectorAll('.filters-panel [role="status"] p')].map((line) => line.textContent ?? '');
const choose = async (label: string): Promise<void> => userEvent.selectOptions(screen.getByRole('combobox', { name: 'seen_at · UTC' }), label);

async function open(held: readonly GraphEdge[] = edges) {
  const workspace = await filtersWorkspace(nodes, undefined, held, true);
  openFilters();
  await act(async () => void (await Promise.resolve()));
  return workspace;
}

describe('the lines while a time window is set', () => {
  it('count the entities and relationships the window filters out, and agree with what is drawn', async () => {
    const { state } = await open();
    await choose('Last 30 days');
    expect(statusLines()).toEqual(['3 of 5 match · exact · 2 hidden', '1 of 2 relationships match']);
    expect(scopeLines()[0]).toContain('5 entities');
    expect(scopeLines()[0]).toContain(' · 2 hidden by filters');
    expect(scopeLines().at(-1)).toBe('3 shown · more not yet retrieved');
    expect(drawnKeys(state.visibleGraph()).size).toBe(3 + 1);
    expect(state.loadedGraph().entities).toEqual({ value: 5, quality: 'exact', scope: 'loaded in this view' });
  });

  it('count an entity once that a type filter and the window both filter out', async () => {
    await open();
    await choose('Last 30 days');
    await userEvent.click(screen.getByRole('button', { name: 'KIND-B' }));
    expect(statusLines()[0]).toBe('2 of 5 match · exact · 3 hidden');
    expect(scopeLines()[0]).toContain(' · 3 hidden by filters');
    expect(scopeLines().at(-1)).toBe('2 shown · more not yet retrieved');
  });

  it('show no hidden line when the window filters nothing out, and the plain lines after Reset', async () => {
    await open([linked('new-a', 'n0', 'n1', new Date().toISOString()), linked('new-b', 'n2', 'n3', new Date().toISOString())]);
    await choose('Last 7 days');
    expect(scopeLines()[0]).not.toContain('hidden by filters');
    expect(statusLines()).toEqual(['5 of 5 match · exact · 0 hidden', '2 of 2 relationships match']);
    await userEvent.click(screen.getByRole('button', { name: 'Reset time window' }));
    expect(statusLines()).toEqual(['5 of 5 match · exact · 0 hidden']);
  });
});
