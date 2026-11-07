import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiFailure } from '../api/client.js';
import { panelWorkspace, searchAnswer, searchFor, settle, setText, TIMEOUT, TYPEAHEAD_DEBOUNCE_MS, typeText, wait } from './panel-test-kit.js';
import { hit } from './search-test-kit.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const exactHit = hit('a', 'ACC-100', { stableCode: 'S-1', tier: 'gold', status: 'Active' });
const prefixHits = [hit('a', 'ACC-1001'), hit('a', 'ACC-1002')];

async function answered(text: string, result = searchAnswer('a', [exactHit], prefixHits)) {
  const parts = await panelWorkspace();
  await searchFor(text);
  const sent = parts.searches[parts.searches.length - 1];
  act(() => sent?.answer({ ok: true, value: result }));
  await settle();
  return { ...parts, sent };
}

describe('the Add from source tab before and while it searches', () => {
  it('shows the caption that names the source and the footnote before anything is typed', async () => {
    await panelWorkspace();
    expect(screen.getByText('Searches only configured, indexed properties in Source a.')).toBeDefined();
    expect(screen.getByText('Adding loads one entity. Its neighbors stay unloaded until you expand it.')).toBeDefined();
  });

  it('says it is searching while the delay runs and the request is in flight, and keeps the earlier answer labelled with its text', async () => {
    await answered('ACC-10');
    expect(screen.queryByText('Showing results for “ACC-10”.')).toBeNull();
    setText('ACC-100');
    expect(screen.getByText('Searching…')).toBeDefined();
    expect(screen.getByText('Showing results for “ACC-10”.')).toBeDefined();
    expect(screen.getByText('Title ACC-100')).toBeDefined();
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    expect(screen.getByText('Searching…')).toBeDefined();
    expect(screen.getByText('Showing results for “ACC-10”.')).toBeDefined();
  });
});

describe('the answer in the Add from source tab', () => {
  it('summarises each group by its own count, in this order, and never adds the starts-with hits to the exact ones', async () => {
    await answered('ACC-10');
    expect(document.querySelector('.search-panel-summary')?.textContent).toBe('1 exact ID match · 2 start with the text · 0.18 s');
  });

  it('lists the exact rows and then the starts-with rows, each with the type and the key properties of the source profile', async () => {
    await answered('ACC-10');
    const exact = screen.getByRole('list', { name: 'Exact ID matches' });
    expect(within(exact).getByText('Title ACC-100')).toBeDefined();
    expect(within(exact).getByText('KIND-A · Active · S-1 · gold')).toBeDefined();
    const prefix = screen.getByRole('list', { name: 'Starts with the text' });
    expect(within(prefix).getAllByRole('listitem')).toHaveLength(2);
    const order = screen.getAllByRole('list').map((list) => list.getAttribute('aria-label'));
    expect(order.indexOf('Exact ID matches')).toBeLessThan(order.indexOf('Starts with the text'));
  });

  it.each([
    [10, 10, '≥ 10 start with the text · lower bound'],
    [25, 25, '≥ 25 start with the text · lower bound'],
    [9, 9, '≥ 9 start with the text · lower bound'],
  ])('says a lower bound of %i for a group of %i hits as a lower bound, whatever the cap is', async (value, hits, text) => {
    const nodes = Array.from({ length: hits }, (_, index) => hit('a', `ACC-${2000 + index}`));
    const result = searchAnswer('a', [], nodes, {});
    const withBound = { ...result, startsWith: result.startsWith === undefined ? undefined : { ...result.startsWith, count: { value, quality: 'lowerBound' as const, scope: 'search:startsWith' } } };
    await answered('ACC', withBound);
    expect(screen.getByText(new RegExp(`0 exact ID matches · ${text}`))).toBeDefined();
  });

  it('says a lower bound of the exact group as a lower bound too', async () => {
    const result = searchAnswer('a', [exactHit], [], { counts: { exact: { value: 10, quality: 'lowerBound', scope: 'search:exact' } } });
    await answered('ACC', result);
    expect(screen.getByText(/≥ 10 exact ID matches · lower bound/)).toBeDefined();
  });

  it('shows the warnings of the rows left out, the one disabled type above the rows of the others, and no "No matching entities"', async () => {
    const result = searchAnswer('a', [exactHit], [], { disabledTypes: [{ entityType: 'kind-b', property: 'code', reason: 'index-unavailable', typeSearched: false }], warnings: ['1 record left out: it has no stable ID.'] });
    await answered('ACC', result);
    expect(screen.getByText('Not searched: kind-b, none of its properties · code: no online index')).toBeDefined();
    expect(screen.getByText('1 record left out: it has no stable ID.')).toBeDefined();
    expect(screen.queryByText('No matching entities')).toBeNull();
  });

  it('shows the warnings of the starts-with group', async () => {
    const result = searchAnswer('a', [], [hit('a', 'ACC-1')]);
    const withWarning = { ...result, startsWith: result.startsWith === undefined ? undefined : { ...result.startsWith, warnings: ['2 records left out: no stable ID.'] } };
    await answered('ACC', withWarning);
    expect(screen.getByText('2 records left out: no stable ID.')).toBeDefined();
  });

  it('names a disabled type even when the types that were searched found nothing, and says "No matching entities" for them', async () => {
    const result = searchAnswer('a', [], [], { disabledTypes: [{ entityType: 'kind-b', property: 'nickname', reason: 'index-building', typeSearched: true }] });
    await answered('ACC', result);
    expect(screen.getByText('Not searched: kind-b · nickname: index is building')).toBeDefined();
    expect(screen.getByText('No matching entities')).toBeDefined();
  });

  it('names every type and says no index was available when every type is disabled, with neither the masking wording nor "No matching entities"', async () => {
    const result = searchAnswer('a', [], [], { searchable: false, disabledTypes: [{ entityType: 'kind-a', property: 'code', reason: 'index-unavailable', typeSearched: false }, { entityType: 'kind-b', property: 'code', reason: 'index-failed', typeSearched: false }] });
    await answered('ACC', result);
    expect(screen.getByText('Not searched: KIND-A, none of its properties · code: no online index')).toBeDefined();
    expect(screen.getByText('Not searched: kind-b, none of its properties · code: index failed')).toBeDefined();
    expect(screen.getByText('No index is available for these types.')).toBeDefined();
    expect(screen.queryByText('No matching entities')).toBeNull();
    expect(screen.queryByText('Nothing can be searched while personal data is masked. Turn masking off to search personal data.')).toBeNull();
  });

  it('says what could not be searched when nothing was searchable, and never "No matching entities"', async () => {
    await answered('ACC', searchAnswer('a', [], [], { searchable: false }));
    expect(screen.getByText('No property of this source is configured for search.')).toBeDefined();
    expect(screen.queryByText('No matching entities')).toBeNull();
  });

  it('says that nothing can be searched while personal data is masked, for a masked session', async () => {
    const parts = await panelWorkspace({ mask: true });
    await searchFor('ACC');
    act(() => parts.searches[0]?.answer({ ok: true, value: searchAnswer('a', [], [], { searchable: false }) }));
    await settle();
    expect(screen.getByText('Nothing can be searched while personal data is masked. Turn masking off to search personal data.')).toBeDefined();
  });

  it('says "No matching entities" for a search that found nothing', async () => {
    await answered('ACC', searchAnswer('a'));
    expect(screen.getByText('No matching entities')).toBeDefined();
  });
});

describe('a group that fails while the other is answered', () => {
  const failure = (group: 'exact' | 'startsWith', code: 'QUERY_TIMEOUT' | 'SOURCE_BUSY' = 'QUERY_TIMEOUT') => ({ group, code, ...(code === 'QUERY_TIMEOUT' ? { timeoutMs: 5000 } : {}) });
  const prefixFailed = () => {
    const base = searchAnswer('a', [exactHit], []);
    return { ...base, failures: [failure('startsWith')], startsWith: { ...base.startsWith, nodes: [], count: { quality: 'unknown' as const, scope: 'search:startsWith' }, dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [] } };
  };

  it('keeps the exact rows and their count, puts one plain line where the starts-with rows would be, shows no number and no "No matching entities" for the group, and offers Retry', async () => {
    await answered('ACC-10', prefixFailed());
    expect(screen.getByText('Title ACC-100')).toBeDefined();
    expect(document.querySelector('.search-panel-summary')?.textContent).toBe('1 exact ID match · matches that start with the text not read · 0.18 s');
    expect(screen.getByText('The matches that start with the text could not be read (timed out after 5 s), so those records were not read.')).toBeDefined();
    expect(screen.queryByText('No matching entities')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('keeps the starts-with rows when the exact read failed, with the failure in place of the exact rows', async () => {
    const base = searchAnswer('a', [], prefixHits);
    const exactFailed = { ...base, failures: [failure('exact', 'SOURCE_BUSY')], counts: { exact: { quality: 'unknown' as const, scope: 'search:exact' } } };
    await answered('ACC-10', exactFailed);
    expect(within(screen.getByRole('list', { name: 'Starts with the text' })).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('The exact ID matches could not be read (SOURCE_BUSY), so those records were not read.')).toBeDefined();
    expect(document.querySelector('.search-panel-summary')?.textContent).toBe('exact ID matches not read · 2 start with the text · 0.18 s');
  });

  it('puts each group where it belongs: the exact rows before the failure line of the starts-with group', async () => {
    await answered('ACC-10', prefixFailed());
    const rows = screen.getByRole('list', { name: 'Exact ID matches' });
    const line = screen.getByText(/could not be read/);
    expect(rows.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers no Retry beneath a retained answer while a newer text is searched, so a Retry never repeats another query', async () => {
    const parts = await answered('ACC-10', prefixFailed());
    setText('ACC-100');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    expect(parts.searches).toHaveLength(2);
    expect(parts.searches[1]?.request.text).toBe('ACC-100');
  });

  it('repeats the whole search on Retry', async () => {
    const parts = await answered('ACC-10', prefixFailed());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await wait(0);
    expect(parts.searches).toHaveLength(2);
    expect(parts.searches[1]?.request).toEqual(parts.searches[0]?.request);
  });
});

describe('the diagnostics of the two groups', () => {
  it('shows a warning that both groups report, once for each group, without a duplicate-key error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = searchAnswer('a', [exactHit], prefixHits, { warnings: ['1 record left out: it has no stable ID.'] });
    const result = { ...base, startsWith: base.startsWith === undefined ? undefined : { ...base.startsWith, warnings: ['1 record left out: it has no stable ID.'] } };
    await answered('ACC', result);
    expect(screen.getAllByText('1 record left out: it has no stable ID.')).toHaveLength(2);
    expect(error.mock.calls.flat().join(' ')).not.toContain('same key');
    error.mockRestore();
  });
});

describe('a search that fails in the Add from source tab', () => {
  async function failed(failure: ApiFailure) {
    const parts = await answered('ACC-10');
    setText('ACC-100');
    await wait(TYPEAHEAD_DEBOUNCE_MS);
    act(() => parts.searches[1]?.answer({ ok: false, failure }));
    await settle();
    return parts;
  }

  it('says that the search timed out and for how long from the error, keeps the earlier rows labelled with their text, and offers Retry', async () => {
    await failed(TIMEOUT);
    expect(screen.getByText('Search timed out after 5 s')).toBeDefined();
    expect(screen.getByText('Your graph was not changed.')).toBeDefined();
    expect(screen.getByText('Showing results for “ACC-10”.')).toBeDefined();
    expect(screen.getByText('Title ACC-100')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('shows the trace ID of a timeout and of a source that is not found, and Retry for both', async () => {
    await failed(TIMEOUT);
    expect(screen.getByText('trace tr-1')).toBeDefined();
    cleanup();
    await failed({ code: 'NOT_FOUND', message: 'gone', retryable: false, traceId: 'tr-5' });
    expect(screen.getByText('The source “a” is not configured.')).toBeDefined();
    expect(screen.getByText('trace tr-5')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('shows the sentence of an unavailable source, and Retry only when its reason says a retry can help', async () => {
    await failed({ code: 'SOURCE_UNAVAILABLE', message: 'A needed index is not there, so the read was not run.', retryable: false, traceId: 'tr-6', details: { reason: 'index-unavailable' } });
    expect(screen.getByText('A needed index is not there, so the read was not run.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    cleanup();
    await failed({ code: 'SOURCE_UNAVAILABLE', message: 'A needed index is still building, so the read is slow. Try again later.', retryable: true, traceId: 'tr-6', details: { reason: 'index-building' } });
    expect(screen.getByText('A needed index is still building, so the read is slow. Try again later.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('shows the trace ID only when the error carries one', async () => {
    await failed({ code: 'SOURCE_UNAVAILABLE', message: 'down', retryable: true, traceId: 'tr-77' });
    expect(screen.getByRole('alert').textContent).toContain('trace tr-77');
    cleanup();
    await failed({ code: 'NETWORK_UNAVAILABLE' });
    expect(screen.getByRole('alert').textContent).not.toContain('trace');
  });

  it('repeats the same call at once on Retry', async () => {
    const parts = await failed(TIMEOUT);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await wait(0);
    expect(parts.searches).toHaveLength(3);
    expect(parts.searches[2]?.request).toEqual(parts.searches[1]?.request);
    expect(screen.queryByText('Search timed out after 5 s')).toBeNull();
  });

  it('shows no failure for a request that a newer text cancelled', async () => {
    const parts = await panelWorkspace();
    await searchFor('ACC-1');
    await typeText('0');
    setText('ACC-10');
    parts.searches[0]?.answer({ ok: false, failure: { code: 'ABORTED' } });
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
