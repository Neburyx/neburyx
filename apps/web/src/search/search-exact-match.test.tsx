import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GraphNode, SearchResult } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { renderApp } from '../test-utils.js';
import { answerOf, hit, relatedOf, searchAt, searchKit } from './search-test-kit.js';

const matches = (nodes: readonly GraphNode[], named: Readonly<Record<string, readonly string[]>>): SearchResult['exactMatches'] =>
  nodes.map((node) => ({ ref: node.ref, matchedProperties: [...(named[node.ref.stableId] ?? [])] }));
const answerWith = (exact: readonly GraphNode[], named: Readonly<Record<string, readonly string[]>>, overrides: Partial<SearchResult> = {}): ApiResult<SearchResult> => ({
  ok: true,
  value: answerOf('demo', exact, { exactMatches: matches(exact, named), ...overrides }),
});
const rowOf = (title: string): HTMLElement => {
  const row = screen.getByText(title).closest('li');
  if (row === null) throw new Error(`no row for ${title}`);
  return row;
};

describe('the property an exact hit matched, on the Search results page', () => {
  it('says which property held the typed text on the row of the hit', async () => {
    const exact = [hit('demo', 'AC-1')];
    renderApp(searchAt('demo', 'AC-1'), searchKit(['demo'], async () => answerWith(exact, { 'AC-1': ['primaryRef'] })).client);
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    expect(within(rowOf('Title AC-1')).getByText('Matches AC-1 in primaryRef')).toBeDefined();
  });

  it('names both properties of a hit that matched in two, in the order the answer gives', async () => {
    const exact = [hit('demo', 'AC-1'), hit('demo', 'AC-2')];
    renderApp(searchAt('demo', 'AC-1'), searchKit(['demo'], async () => answerWith(exact, { 'AC-1': ['primaryRef', 'legacyRef'], 'AC-2': ['legacyRef'] })).client);
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (2)' });
    expect(within(rowOf('Title AC-1')).getByText('Matches AC-1 in primaryRef, legacyRef')).toBeDefined();
    expect(within(rowOf('Title AC-2')).getByText('Matches AC-1 in legacyRef')).toBeDefined();
  });

  it('shows no line on a row whose entry names no property', async () => {
    const exact = [hit('demo', 'AC-1')];
    renderApp(searchAt('demo', 'AC-1'), searchKit(['demo'], async () => answerWith(exact, {})).client);
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    expect(within(rowOf('Title AC-1')).queryByText(/^Matches /)).toBeNull();
  });

  it('shows no matched-property line when the exact group is empty', async () => {
    renderApp(searchAt('demo', 'AC-1'), searchKit(['demo'], async () => answerWith([], {})).client);
    expect(await screen.findByRole('heading', { level: 2, name: 'No matching entities' })).toBeDefined();
    expect(screen.queryByText(/^Matches /)).toBeNull();
  });

  it('says "Matches" on the exact row and "References" on the related row of a hit in both groups', async () => {
    const both = hit('demo', 'AC-1');
    const kit = searchKit(['demo'], async () =>
      answerWith([both], { 'AC-1': ['primaryRef'] }, { related: relatedOf([both], undefined, { 'AC-1': ['batchRef'] }) }),
    );
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    const exact = await screen.findByRole('region', { name: 'Exact ID match (1)' });
    const related = screen.getByRole('region', { name: 'Related records · Referenced ID (1)' });
    expect(within(exact).getByText('Matches AC-1 in primaryRef')).toBeDefined();
    expect(within(exact).queryByText(/^References /)).toBeNull();
    expect(within(related).getByText('References AC-1 in batchRef')).toBeDefined();
    expect(within(related).queryByText(/^Matches /)).toBeNull();
  });
});
