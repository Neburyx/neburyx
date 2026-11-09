import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphNode, SearchMoreResult, SearchResult, UnreferencedHit } from '@neburyx/contracts';
import { MORE_COPY, UNREFERENCED_TEXT } from './copy.js';
import { panelWorkspace, searchAnswer, searchFor, settle, setText, TIMEOUT, TYPEAHEAD_DEBOUNCE_MS, wait, type PanelWorkspace } from './panel-test-kit.js';
import { hit } from './search-test-kit.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const DROPPED = { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 };
const nodes = (prefix: string, from: number, count: number): GraphNode[] => Array.from({ length: count }, (_, index) => hit('a', `${prefix}-${from + index}`));
const lowerBound = (value: number, scope: string) => ({ value, quality: 'lowerBound' as const, scope });
const unreferenced = (title: string): UnreferencedHit => ({ entityType: 'kind-a', title, properties: [], reason: 'no-stable-id' });

const FIRST_PAGE_HELD = 2;

/** A first answer whose exact group has a next page and whose startsWith group, a capped read, was cut: a lower bound with no cursor. */
function paged(): SearchResult {
  const result = searchAnswer('a', nodes('ACC-1', 0, 2), nodes('ACC-2', 0, 2), { counts: { exact: lowerBound(2, 'search:exact') }, exactNextCursor: 'exact-1' });
  const startsWith = result.startsWith;
  if (startsWith === undefined) throw new Error('the answer has no startsWith group');
  return { ...result, startsWith: { ...startsWith, count: lowerBound(2, 'search:startsWith') } };
}

/** A page of the exact group, its count as the server gives it: the hits of every page so far, the first page's two and these. */
function page(added: readonly GraphNode[], hits: readonly UnreferencedHit[] = []): SearchMoreResult {
  return { sourceId: 'a', group: 'exact', nodes: [...added], matches: added.map((node) => ({ ref: node.ref, matchedProperties: [] })), count: { value: FIRST_PAGE_HELD + added.length + hits.length, quality: 'exact', scope: 'search:exact' }, dropped: DROPPED, warnings: [], ...(hits.length === 0 ? {} : { unreferenced: [...hits] }) };
}

async function answered(result: SearchResult = paged(), text = 'ACC'): Promise<PanelWorkspace> {
  const parts = await panelWorkspace();
  await searchFor(text);
  const sent = parts.searches[parts.searches.length - 1];
  act(() => sent?.answer({ ok: true, value: result }));
  await settle();
  return parts;
}

const button = (name: string) => screen.getByRole('button', { name });
const EXACT_MORE = 'Show more: Exact matches';
const PREFIX_MORE = 'Show more: Matches that start with the text';

describe('Show more in the Add from source tab', () => {
  it('is under the exact group when it has a cursor, never under the startsWith group, even when its count is a lower bound, and not under an exact group without a cursor', async () => {
    await answered();
    expect(button(EXACT_MORE)).toBeDefined();
    expect(screen.queryByRole('button', { name: PREFIX_MORE })).toBeNull();
    expect(document.querySelector('.search-panel-summary')?.textContent).toContain('≥ 2 start with the text · lower bound');
    cleanup();
    await answered(searchAnswer('a', nodes('ACC-1', 0, 1), nodes('ACC-2', 0, 1)));
    expect(screen.queryByRole('button', { name: EXACT_MORE })).toBeNull();
    expect(screen.queryByRole('button', { name: PREFIX_MORE })).toBeNull();
  });

  it('reads the next page of the exact group with the text and the mask of the answer, is busy meanwhile with the hits kept, then appends the hits, counts them and puts the focus on the first new one', async () => {
    const parts = await answered();
    fireEvent.click(button(EXACT_MORE));
    expect(parts.pages.map((sent) => sent.request)).toEqual([{ sourceId: 'a', text: 'ACC', group: 'exact', cursor: 'exact-1' }]);
    expect(button(EXACT_MORE).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText(MORE_COPY.loadingMore)).toBeDefined();
    expect(within(screen.getByRole('list', { name: 'Exact ID matches' })).getAllByRole('listitem')).toHaveLength(2);
    act(() => parts.pages[0]?.answer({ ok: true, value: page(nodes('ACC-1', 2, 2)) }));
    await settle();
    const rows = within(screen.getByRole('list', { name: 'Exact ID matches' })).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(document.activeElement).toBe(rows[2]);
    expect(document.querySelector('.search-panel-summary')?.textContent).toContain('4 exact ID matches · ≥ 2 start with the text · lower bound');
    expect(screen.queryByRole('button', { name: EXACT_MORE })).toBeNull();
  });

  it('leaves out of the startsWith group a node that a later page of the exact group brings', async () => {
    const parts = await answered();
    fireEvent.click(button(EXACT_MORE));
    act(() => parts.pages[0]?.answer({ ok: true, value: page(nodes('ACC-2', 0, 1)) }));
    await settle();
    const titles = within(screen.getByRole('list', { name: 'Starts with the text' })).getAllByRole('listitem').map((row) => row.textContent ?? '');
    expect(titles).toHaveLength(1);
    expect(titles.some((title) => title.includes('ACC-2-0'))).toBe(false);
  });

  it('lists a hit with no usable stable ID that a page holds, with no Add button', async () => {
    const parts = await answered();
    fireEvent.click(button(EXACT_MORE));
    act(() => parts.pages[0]?.answer({ ok: true, value: page([], [unreferenced('Lamp')]) }));
    await settle();
    const row = screen.getByRole('listitem', { name: `Lamp, KIND-A: ${UNREFERENCED_TEXT}` });
    expect(within(row).queryByRole('button')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('names a failed page with Retry, keeps the hits, and runs the same page again', async () => {
    const parts = await answered();
    fireEvent.click(button(EXACT_MORE));
    act(() => parts.pages[0]?.answer({ ok: false, failure: TIMEOUT }));
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('More exact matches were not read');
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    expect(parts.reported).not.toHaveBeenCalled();
    expect(within(screen.getByRole('list', { name: 'Exact ID matches' })).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(parts.pages.map((sent) => sent.request.cursor)).toEqual(['exact-1', 'exact-1']);
  });

  it('says a page that is no longer valid and offers to search again, which sends the search again', async () => {
    const parts = await answered();
    fireEvent.click(button(EXACT_MORE));
    act(() => parts.pages[0]?.answer({ ok: false, failure: { code: 'CURSOR_INVALIDATED', message: 'stale', retryable: false, traceId: 'tr-1' } }));
    await settle();
    expect(screen.getByText(MORE_COPY.invalidated)).toBeDefined();
    const before = parts.searches.length;
    fireEvent.click(button(MORE_COPY.searchAgain));
    await wait(0);
    expect(parts.searches.length).toBe(before + 1);
  });

  it('discards a page that answers after the text changed, and offers no Show more for an answer of earlier text', async () => {
    const parts = await answered();
    fireEvent.click(button(EXACT_MORE));
    setText('ACC-');
    expect(screen.queryByRole('button', { name: EXACT_MORE })).toBeNull();
    act(() => parts.pages[0]?.answer({ ok: true, value: page(nodes('ACC-1', 2, 2)) }));
    await settle();
    expect(within(screen.getByRole('list', { name: 'Exact ID matches' })).getAllByRole('listitem')).toHaveLength(2);
    await wait(TYPEAHEAD_DEBOUNCE_MS);
  });

  it('aborts a page and never shows it once masking is turned on', async () => {
    const parts = await answered();
    fireEvent.click(button(EXACT_MORE));
    const [sent] = parts.pages;
    act(() => parts.state.setMask(true));
    await settle();
    expect(sent?.signal?.aborted).toBe(true);
    act(() => sent?.answer({ ok: true, value: page(nodes('ACC-1', 2, 2)) }));
    await settle();
    expect(screen.queryByText('Title ACC-1-2')).toBeNull();
  });
});

describe('a hit with no usable stable ID in the Add from source tab', () => {
  it('is listed in its group with the text that it cannot be opened or added, with no Add button, and the tab does not say nothing matched', async () => {
    const first = searchAnswer('a', [], [], { exactUnreferenced: [unreferenced('Lamp')], counts: { exact: { value: 1, quality: 'exact', scope: 'search:exact' } } });
    const startsWith = first.startsWith;
    if (startsWith === undefined) throw new Error('the answer has no startsWith group');
    await answered({ ...first, startsWith: { ...startsWith, unreferenced: [unreferenced('Desk')], count: { value: 1, quality: 'exact', scope: 'search:startsWith' } } });
    for (const [list, title] of [['Exact ID matches', 'Lamp'], ['Starts with the text', 'Desk']] as const) {
      const row = within(screen.getByRole('list', { name: list })).getByRole('listitem', { name: `${title}, KIND-A: ${UNREFERENCED_TEXT}` });
      expect(within(row).getByText(UNREFERENCED_TEXT)).toBeDefined();
      expect(within(row).queryByRole('button')).toBeNull();
    }
    expect(screen.queryByText('No matching entities')).toBeNull();
  });
});

describe('the matched properties in the exact results of the Add from source tab', () => {
  const named = (list: readonly GraphNode[], properties: readonly string[]) => list.map((node) => ({ ref: node.ref, matchedProperties: [...properties] }));
  const rowOf = (title: string): HTMLElement => {
    const row = screen.getByText(title).closest('li');
    if (row === null) throw new Error(`no row for ${title}`);
    return row;
  };

  it('says which properties held the typed text on each exact row, and nothing on a row whose entry names none or on a starts-with row', async () => {
    const exact = nodes('ACC-1', 0, 3);
    const entries = [...named(exact.slice(0, 1), ['primaryRef']), ...named(exact.slice(1, 2), ['primaryRef', 'legacyRef']), ...named(exact.slice(2), [])];
    await answered(searchAnswer('a', exact, nodes('ACC-2', 0, 1), { exactMatches: entries }), 'ACC');
    expect(within(rowOf('Title ACC-1-0')).getByText('Matches ACC in primaryRef')).toBeDefined();
    expect(within(rowOf('Title ACC-1-1')).getByText('Matches ACC in primaryRef, legacyRef')).toBeDefined();
    expect(within(rowOf('Title ACC-1-2')).queryByText(/^Matches /)).toBeNull();
    expect(within(rowOf('Title ACC-2-0')).queryByText(/^Matches /)).toBeNull();
  });

  it('shows the line on the rows a next page adds', async () => {
    const parts = await answered(searchAnswer('a', nodes('ACC-1', 0, 1), nodes('ACC-2', 0, 1), { exactMatches: named(nodes('ACC-1', 0, 1), ['primaryRef']), counts: { exact: lowerBound(1, 'search:exact') }, exactNextCursor: 'exact-1' }), 'ACC');
    fireEvent.click(button(EXACT_MORE));
    const added = nodes('ACC-1', 1, 1);
    act(() => parts.pages[0]?.answer({ ok: true, value: { sourceId: 'a', group: 'exact', nodes: added, matches: named(added, ['legacyRef']), count: { value: 2, quality: 'exact', scope: 'search:exact' }, dropped: DROPPED, warnings: [] } }));
    await settle();
    expect(within(rowOf('Title ACC-1-1')).getByText('Matches ACC in legacyRef')).toBeDefined();
    expect(within(rowOf('Title ACC-1-0')).getByText('Matches ACC in primaryRef')).toBeDefined();
  });
});
