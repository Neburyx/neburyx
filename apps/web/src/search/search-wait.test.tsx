import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchMoreResult, SearchResult } from '@neburyx/contracts';
import type { ApiClient, ApiResult } from '../api/client.js';
import { READ_WAIT_MS, SEARCH_MORE_WAIT_MS, SEARCH_WAIT_MS, TYPEAHEAD_WAIT_MS } from '../api/read-wait.js';
import { renderApp } from '../test-utils.js';
import { panelWorkspace, searchAnswer, searchFor } from './panel-test-kit.js';
import { answerOf, deferred, hit, profiled, searchAt, searchKit } from './search-test-kit.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wait = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const hang = () => new Promise<never>(() => undefined);
const press = async (element: HTMLElement) => {
  await act(async () => void fireEvent.click(element));
  await wait();
};
const main = () => within(screen.getByRole('main'));
const ok = <Value,>(value: Value): ApiResult<Value> => ({ ok: true, value });
const UNREACHABLE = 'The server could not be reached.';
const found = ok(answerOf('demo', [hit('demo', 'AC-1')]));
const heading = () => screen.queryByRole('heading', { level: 2, name: /Exact ID match/ });

/** Lets the reads that come one after another (the sources and the person, the profile, the search) be made, with no time passing: each waits for the page to be drawn again. */
const searched = async (kit: { readonly searches: readonly unknown[] }) => {
  for (let round = 0; round < 5; round += 1) await wait();
  expect(kit.searches).toHaveLength(1);
};

describe('the Search page: a read that gets no answer', () => {
  it('ends the read of the profile that gates the results at the bound, with Try again, after which the search runs', async () => {
    const kit = searchKit(['demo'], async () => found);
    let profiles = 0;
    const client: ApiClient = { ...kit.client, getProfile: (sourceId) => (++profiles === 1 ? hang() : Promise.resolve(ok(profiled(sourceId)))) };
    renderApp(searchAt('demo', 'AC-1'), client);
    await wait(READ_WAIT_MS - 1);
    expect(main().getByRole('status').textContent).toBe('Loading sources…');
    expect(main().queryByText('The source could not be read.')).toBeNull();
    await wait(1);
    expect(main().getByText('The source could not be read.')).toBeTruthy();
    expect(main().getByText(UNREACHABLE)).toBeTruthy();
    expect(kit.searches).toHaveLength(0);
    await press(main().getByRole('button', { name: 'Try again' }));
    expect(profiles).toBe(2);
    expect(kit.searches).toHaveLength(1);
    expect(heading()).toBeTruthy();
  });

  it('ends a search at the longer bound, with Retry, and takes the results that then come after the usual wait', async () => {
    const answer = deferred<ApiResult<SearchResult>>();
    let searches = 0;
    const kit = searchKit(['demo'], () => (++searches === 1 ? hang() : answer.promise));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await searched(kit);
    await wait(SEARCH_WAIT_MS - 1);
    expect(main().getByText('Searching…')).toBeTruthy();
    expect(main().queryByText(UNREACHABLE)).toBeNull();
    await wait(1);
    expect(main().getByText(UNREACHABLE)).toBeTruthy();
    expect(main().queryByText('Searching…')).toBeNull();
    expect(document.querySelector('.search-results')?.getAttribute('aria-busy')).toBe('false');
    await press(main().getByRole('button', { name: 'Retry' }));
    expect(kit.searches).toHaveLength(2);
    await wait(READ_WAIT_MS + 5000);
    expect(kit.signals[1]?.aborted).toBe(false);
    expect(main().queryByText(UNREACHABLE)).toBeNull();
    await act(async () => answer.settle(found));
    expect(heading()).toBeTruthy();
  });

  const firstPage = ok(answerOf('demo', [hit('demo', 'AC-1')], { counts: { exact: { value: 1, quality: 'lowerBound', scope: 'search:exact' } }, exactNextCursor: 'cursor-1' }));
  const nextPage: ApiResult<SearchMoreResult> = ok({
    sourceId: 'demo',
    group: 'exact',
    nodes: [hit('demo', 'AC-2')],
    matches: [{ ref: hit('demo', 'AC-2').ref, matchedProperties: [] }],
    count: { value: 2, quality: 'exact', scope: 'search:exact' },
    dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 },
    warnings: [],
  });
  const showMore = () => main().getByRole('button', { name: 'Show more: Exact matches' });
  const paged = async (more: ApiClient['searchMore']) => {
    const kit = searchKit(['demo'], async () => firstPage);
    renderApp(searchAt('demo', 'AC-1'), { ...kit.client, searchMore: more });
    await wait();
    await press(showMore());
  };

  it('ends a Show more at the longer bound, with Retry, and takes the page that then comes after the usual wait', async () => {
    const answer = deferred<ApiResult<SearchMoreResult>>();
    let more = 0;
    await paged(() => (++more === 1 ? hang() : answer.promise));
    await wait(SEARCH_MORE_WAIT_MS - 1);
    expect(showMore().getAttribute('aria-disabled')).toBe('true');
    expect(main().queryByText(UNREACHABLE)).toBeNull();
    await wait(1);
    expect(main().getByText(UNREACHABLE)).toBeTruthy();
    expect(main().queryByText('Loading more…')).toBeNull();
    await press(main().getByRole('button', { name: 'Retry' }));
    expect(more).toBe(2);
    await wait(READ_WAIT_MS + 5000);
    expect(showMore().getAttribute('aria-busy')).toBe('true');
    expect(main().queryByText(UNREACHABLE)).toBeNull();
    await act(async () => answer.settle(nextPage));
    expect(main().getByText('Title AC-2')).toBeTruthy();
  });
});

describe('type-ahead that gets no answer', () => {
  const hits = ok(searchAnswer('a', [hit('a', 'AC-9')]));

  it('ends at the longer bound, with Retry, and takes the answer that then comes after the usual wait', async () => {
    const { searches } = await panelWorkspace();
    await searchFor('AC');
    // the request left 10 ms before the typing helper returned
    await wait(TYPEAHEAD_WAIT_MS - 11);
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    await wait(1);
    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
    expect(searches[0]?.signal?.aborted).toBe(true);
    expect(screen.queryByText('Searching…')).toBeNull();
    await press(screen.getByRole('button', { name: 'Retry' }));
    await wait();
    expect(searches).toHaveLength(2);
    await wait(READ_WAIT_MS + 5000);
    expect(searches[1]?.signal?.aborted).toBe(false);
    await act(async () => searches[1]?.answer(hits));
    expect(screen.getByText('Title AC-9')).toBeTruthy();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
  });
});
