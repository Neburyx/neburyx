import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { GraphNode, SearchMoreRequest, SearchMoreResult, SearchResult } from '@neburyx/contracts';
import type { ApiClient, ApiResult } from '../api/client.js';
import { createClientState } from '../state/client-state.js';
import { renderApp, renderAppWithCauses } from '../test-utils.js';
import { answerOf, deferred, evidenceHit, evidenceOf, facetsOf, hit, relatedOf, searchAt, searchKit, type SearchKit } from './search-test-kit.js';

const main = () => screen.getByRole('main');
const ok = <Value,>(value: Value): ApiResult<Value> => ({ ok: true, value });
const hits = (from: number, count: number): GraphNode[] => Array.from({ length: count }, (_, index) => hit('demo', `W-${String(from + index).padStart(2, '0')}`));
const lowerBound = (value: number, scope = 'search:exact') => ({ value, quality: 'lowerBound' as const, scope });
const DROPPED = { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 };

const firstPage = (overrides: Partial<SearchResult> = {}): SearchResult => answerOf('demo', hits(0, 25), { counts: { exact: lowerBound(25) }, exactNextCursor: 'cursor-1', ...overrides });
/** A page of the exact group after `from` hits: as the server counts it, the hits of every page so far, `from` and these. */
const exactPage = (from: number, count: number, nextCursor?: string): SearchMoreResult => ({
  sourceId: 'demo',
  group: 'exact',
  nodes: hits(from, count),
  matches: hits(from, count).map((node) => ({ ref: node.ref, matchedProperties: [] })),
  count: nextCursor === undefined ? { value: from + count, quality: 'exact', scope: 'search:exact' } : lowerBound(from + count),
  ...(nextCursor === undefined ? {} : { nextCursor }),
  dropped: DROPPED,
  warnings: [],
});

interface MoreKit extends SearchKit {
  readonly pages: SearchMoreRequest[];
  readonly signals: (AbortSignal | undefined)[];
}

function moreKit(first: () => Promise<ApiResult<SearchResult>>, more: (request: SearchMoreRequest) => Promise<ApiResult<SearchMoreResult>>): MoreKit {
  const kit = searchKit(['demo'], first);
  const pages: SearchMoreRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const client: ApiClient = {
    ...kit.client,
    searchMore: (request, signal) => {
      pages.push(request);
      signals.push(signal);
      return more(request);
    },
  };
  return { ...kit, client, pages, signals };
}

const showMore = (name = 'Show more: Exact matches') => within(main()).getByRole('button', { name });

describe('Show more under a group that has more matches', () => {
  it('is under a group with a cursor only, and a keyboard user reaches it with Tab and runs it with Enter', async () => {
    const kit = moreKit(
      async () => ok(firstPage({ related: relatedOf([hit('demo', 'REF-1')]) })),
      async () => ok(exactPage(25, 25, 'cursor-2')),
    );
    renderApp(searchAt('demo', 'needle'), kit.client);
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (≥ 25 · lower bound)' });
    expect(within(main()).queryByRole('button', { name: 'Show more: Related records' })).toBeNull();
    const user = userEvent.setup();
    for (let presses = 0; presses < 80 && document.activeElement !== showMore(); presses += 1) await user.tab();
    expect(document.activeElement).toBe(showMore());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(kit.pages).toEqual([{ sourceId: 'demo', text: 'needle', group: 'exact', cursor: 'cursor-1' }]));
  });

  it('runs with Space too', async () => {
    const kit = moreKit(async () => ok(firstPage()), async () => ok(exactPage(25, 25, 'cursor-2')));
    renderApp(searchAt('demo', 'needle'), kit.client);
    await screen.findByRole('heading', { level: 2, name: /Exact ID match/ });
    showMore().focus();
    await userEvent.setup().keyboard(' ');
    await waitFor(() => expect(kit.pages).toHaveLength(1));
  });

  it('is busy while it runs with the hits shown kept, appends the next hits, counts them as the answer says and puts the focus on the first new hit', async () => {
    const second = deferred<ApiResult<SearchMoreResult>>();
    const third = deferred<ApiResult<SearchMoreResult>>();
    const kit = moreKit(async () => ok(firstPage()), (request) => (request.cursor === 'cursor-1' ? second.promise : third.promise));
    renderApp(searchAt('demo', 'needle'), kit.client);
    await screen.findByRole('heading', { level: 2, name: /Exact ID match/ });
    const user = userEvent.setup();
    await user.click(showMore());
    expect(showMore().getAttribute('aria-busy')).toBe('true');
    expect(showMore().getAttribute('aria-disabled')).toBe('true');
    expect(showMore().textContent).toBe('Loading more…');
    expect(within(main()).getByText('Title W-24')).toBeDefined();
    await user.click(showMore());
    expect(kit.pages).toHaveLength(1);
    await act(async () => second.settle(ok(exactPage(25, 25, 'cursor-2'))));
    expect(await screen.findByRole('heading', { level: 2, name: 'Exact ID match (≥ 50 · lower bound)' })).toBeDefined();
    expect(within(main()).getByText('≥ 50 exact matches · lower bound', { exact: false })).toBeDefined();
    expect(within(main()).getAllByRole('button', { name: /^Open in graph/ })).toHaveLength(50);
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Title W-25'));
    await user.click(showMore());
    expect(kit.pages[1]).toMatchObject({ cursor: 'cursor-2' });
    await act(async () => third.settle(ok(exactPage(50, 11))));
    expect(await screen.findByRole('heading', { level: 2, name: 'Exact ID match (61)' })).toBeDefined();
    expect(within(main()).queryByRole('button', { name: 'Show more: Exact matches' })).toBeNull();
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Title W-50'));
  });

  it('adds the next pages of the related and the evidence groups to their own lists', async () => {
    const kit = moreKit(
      async () => ok(answerOf('demo', [], { related: { ...relatedOf([hit('demo', 'REF-1')]), count: lowerBound(1, 'search:related'), nextCursor: 'related-1' }, evidence: { ...evidenceOf([evidenceHit('L-1')]), count: lowerBound(1, 'search:evidence'), nextCursor: 'evidence-1' } })),
      async (request) =>
        ok(
          request.group === 'related'
            ? { sourceId: 'demo', group: 'related', hits: [{ node: hit('demo', 'REF-2'), matchedProperties: ['batchRef'] }], count: { value: 2, quality: 'exact', scope: 'search:related' }, dropped: DROPPED, warnings: [] }
            : { sourceId: 'demo', group: 'evidence', hits: [evidenceHit('L-2')], count: { value: 2, quality: 'exact', scope: 'search:evidence' }, dropped: DROPPED, warnings: [] },
        ),
    );
    renderApp(searchAt('demo', 'needle'), kit.client);
    const user = userEvent.setup();
    await user.click(await within(main()).findByRole('button', { name: 'Show more: Related records' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Related records · Referenced ID (2)' })).toBeDefined();
    expect(within(main()).getByText('References needle in batchRef')).toBeDefined();
    await user.click(within(main()).getByRole('button', { name: 'Show more: Evidence records' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Evidence records · Supporting relationships (2)' })).toBeDefined();
    expect(kit.pages.map((page) => [page.group, page.cursor])).toEqual([
      ['related', 'related-1'],
      ['evidence', 'evidence-1'],
    ]);
  });

  it('shows the group count the server gives for the page as it is, and never adds the pages up itself', async () => {
    const kit = moreKit(async () => ok(firstPage()), async () => ok({ ...exactPage(25, 25, 'cursor-2'), count: lowerBound(70) }));
    renderApp(searchAt('demo', 'needle'), kit.client);
    await userEvent.setup().click(await within(main()).findByRole('button', { name: 'Show more: Exact matches' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Exact ID match (≥ 70 · lower bound)' })).toBeDefined();
    expect(within(main()).getAllByRole('button', { name: /^Open in graph/ })).toHaveLength(50);
  });

  it('sends the mask and the entity types of the search with the page', async () => {
    const kit = moreKit(async () => ok(firstPage({ filters: { entityTypes: ['kind-a'], matchModes: [] } })), async () => ok(exactPage(25, 1)));
    const state = createClientState();
    state.setMask(true);
    renderApp(searchAt('demo', 'needle', '&type=kind-a'), kit.client, state);
    await userEvent.setup().click(await within(main()).findByRole('button', { name: 'Show more: Exact matches' }));
    await waitFor(() => expect(kit.pages).toEqual([{ sourceId: 'demo', text: 'needle', group: 'exact', cursor: 'cursor-1', mask: true, entityTypes: ['kind-a'] }]));
  });
});

describe('Show more that fails', () => {
  it('names a failure of the group, keeps the hits, and Retry reads the same page again', async () => {
    let calls = 0;
    const kit = moreKit(async () => ok(firstPage()), async () =>
      calls++ === 0
        ? ok<SearchMoreResult>({ sourceId: 'demo', group: 'exact', nodes: [], matches: [], count: { quality: 'unknown', scope: 'search:exact' }, dropped: DROPPED, warnings: [], failure: { group: 'exact', code: 'QUERY_TIMEOUT', timeoutMs: 5000 } })
        : ok(exactPage(25, 3)),
    );
    const view = renderAppWithCauses(searchAt('demo', 'needle'), kit.client);
    const user = userEvent.setup();
    await user.click(await within(main()).findByRole('button', { name: 'Show more: Exact matches' }));
    expect((await within(main()).findByRole('alert')).textContent).toBe('More exact matches were not read: the source did not answer within 5 s.');
    expect(view.reported).not.toHaveBeenCalled();
    expect(within(main()).getAllByRole('button', { name: /^Open in graph/ })).toHaveLength(25);
    expect(screen.getByRole('heading', { level: 2, name: 'Exact ID match (≥ 25 · lower bound)' })).toBeDefined();
    await user.click(within(main()).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Exact ID match (28)' })).toBeDefined();
    expect(kit.pages.map((page) => page.cursor)).toEqual(['cursor-1', 'cursor-1']);
    expect(within(main()).queryByRole('alert')).toBeNull();
  });

  it('names a failed request by its code and trace, keeps the hits and offers Retry', async () => {
    const kit = moreKit(async () => ok(firstPage()), async () => ({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'The source is not available.', retryable: true, traceId: 'tr-more' } }));
    renderApp(searchAt('demo', 'needle'), kit.client);
    await userEvent.setup().click(await within(main()).findByRole('button', { name: 'Show more: Exact matches' }));
    expect((await within(main()).findByRole('alert')).textContent).toBe('The source did not answer. Try again shortly. · trace tr-more');
    expect(within(main()).getAllByRole('button', { name: /^Open in graph/ })).toHaveLength(25);
    expect(within(main()).getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('names a page refused for an index that failed by its sentence, keeps the hits and offers no Retry', async () => {
    const message = 'A needed index failed, so the read was not run.';
    const kit = moreKit(async () => ok(firstPage()), async () => ({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message, retryable: false, traceId: 'tr-more', details: { reason: 'index-failed' } } }));
    renderApp(searchAt('demo', 'needle'), kit.client);
    await userEvent.setup().click(await within(main()).findByRole('button', { name: 'Show more: Exact matches' }));
    expect((await within(main()).findByRole('alert')).textContent).toBe(`${message} · trace tr-more`);
    expect(within(main()).getAllByRole('button', { name: /^Open in graph/ })).toHaveLength(25);
    expect(within(main()).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('says a page that is no longer valid cannot be read and offers to search again, which repeats the search', async () => {
    const kit = moreKit(async () => ok(firstPage()), async () => ({ ok: false, failure: { code: 'CURSOR_INVALIDATED', message: 'This page of results is no longer valid. Start again.', retryable: false, traceId: 'tr-old' } }));
    renderApp(searchAt('demo', 'needle'), kit.client);
    const user = userEvent.setup();
    await user.click(await within(main()).findByRole('button', { name: 'Show more: Exact matches' }));
    expect((await within(main()).findByRole('alert')).textContent).toContain('This page of results is no longer valid. Search again to see the rest.');
    expect(within(main()).queryByRole('button', { name: 'Show more: Exact matches' })).toBeNull();
    expect(within(main()).queryByRole('button', { name: 'Retry' })).toBeNull();
    await user.click(within(main()).getByRole('button', { name: 'Search again' }));
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    expect(kit.searches[1]).toEqual(kit.searches[0]);
  });
});

describe('a page that answers after the search changed', () => {
  it('is discarded when the text changes while it runs', async () => {
    const page = deferred<ApiResult<SearchMoreResult>>();
    const newer = deferred<ApiResult<SearchResult>>();
    let calls = 0;
    const kit = moreKit(() => (calls++ === 0 ? Promise.resolve(ok(firstPage())) : newer.promise), () => page.promise);
    renderApp(searchAt('demo', 'needle'), kit.client);
    const user = userEvent.setup();
    await user.click(await within(main()).findByRole('button', { name: 'Show more: Exact matches' }));
    const box = within(main()).getByRole('searchbox', { name: 'Search text' });
    await user.clear(box);
    await user.type(box, 'other{Enter}');
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    await act(async () => page.settle(ok(exactPage(25, 25, 'cursor-2'))));
    expect(within(main()).queryByText('Title W-25')).toBeNull();
    expect(within(main()).queryByRole('button', { name: 'Show more: Exact matches' })).toBeNull();
    await act(async () => newer.settle(ok(answerOf('demo', [hit('demo', 'OTHER')]))));
    expect(await within(main()).findByText('Title OTHER')).toBeDefined();
    expect(within(main()).queryByText('Title W-25')).toBeNull();
  });

  it('never shows a page read unmasked once masking is turned on, and aborts it', async () => {
    const page = deferred<ApiResult<SearchMoreResult>>();
    const masked = deferred<ApiResult<SearchResult>>();
    let calls = 0;
    const kit = moreKit(() => (calls++ === 0 ? Promise.resolve(ok(firstPage())) : masked.promise), () => page.promise);
    const state = createClientState();
    renderApp(searchAt('demo', 'needle'), kit.client, state);
    await userEvent.setup().click(await within(main()).findByRole('button', { name: 'Show more: Exact matches' }));
    await act(async () => state.setMask(true));
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    expect(kit.signals[0]?.aborted).toBe(true);
    const unmasked = { ...exactPage(25, 1), nodes: [hit('demo', 'W-25', { status: 'unmasked-value' })] };
    await act(async () => page.settle(ok(unmasked)));
    await act(async () => masked.settle(ok(answerOf('demo', [hit('demo', 'W-00')]))));
    expect(await within(main()).findByText('Title W-00')).toBeDefined();
    expect(screen.queryByText('unmasked-value', { exact: false })).toBeNull();
    expect(screen.queryByText('Title W-25')).toBeNull();
  });

  it('is discarded when the selection changes while it runs', async () => {
    const page = deferred<ApiResult<SearchMoreResult>>();
    const kit = moreKit(async () => ok(firstPage({ facets: facetsOf({ total: 30, types: [['kind-a', 30]], modes: [['exact', 30]] }) })), () => page.promise);
    renderApp(searchAt('demo', 'needle'), kit.client);
    const user = userEvent.setup();
    await user.click(await within(main()).findByRole('button', { name: 'Show more: Exact matches' }));
    await user.click(screen.getByRole('checkbox', { name: /Exact ID/ }));
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    await act(async () => page.settle(ok(exactPage(25, 5))));
    await waitFor(() => expect(within(main()).queryByText('Title W-25')).toBeNull());
  });
});

describe('the facets beside a group that Show more extended', () => {
  it('shows a lower-bound facet below the hits held as at least the hits held, and an exact one as it is', async () => {
    const kit = moreKit(async () => ok(firstPage({ facets: facetsOf({ total: [25, 'lowerBound'], types: [['kind-a', [25, 'lowerBound']]], modes: [['exact', [25, 'lowerBound']], ['related', 0]] }) })), async () => ok(exactPage(25, 25, 'cursor-2')));
    renderApp(searchAt('demo', 'needle'), kit.client);
    const filters = await screen.findByRole('complementary', { name: 'Filters' });
    expect(within(filters).getByText('≥ 25 entities · lower bound')).toBeDefined();
    await userEvent.setup().click(within(main()).getByRole('button', { name: 'Show more: Exact matches' }));
    expect(await within(filters).findByText('≥ 50 entities · lower bound')).toBeDefined();
    expect(within(filters).queryByText('≥ 25 entities · lower bound')).toBeNull();
  });
});

describe('the matched properties of the hits Show more added', () => {
  const named = (from: number, count: number, property: string) => hits(from, count).map((node) => ({ ref: node.ref, matchedProperties: [property] }));

  it('shows the line on the rows of the next page as on the first, and keeps the first entry of a hit that a later page brings again', async () => {
    const first = firstPage({ exactMatches: named(0, 25, 'primaryRef') });
    const next: SearchMoreResult = { sourceId: 'demo', group: 'exact', nodes: hits(24, 2), matches: named(24, 2, 'legacyRef'), count: { value: 26, quality: 'exact', scope: 'search:exact' }, dropped: DROPPED, warnings: [] };
    const kit = moreKit(async () => ok(first), async () => ok(next));
    renderApp(searchAt('demo', 'needle'), kit.client);
    await screen.findByRole('heading', { level: 2, name: /Exact ID match/ });
    await userEvent.setup().click(showMore());
    const rowOf = (title: string): HTMLElement => {
      const row = within(main()).getByText(title).closest('li');
      if (row === null) throw new Error(`no row for ${title}`);
      return row;
    };
    await waitFor(() => expect(within(main()).getByText('Title W-25')).toBeDefined());
    expect(within(rowOf('Title W-25')).getByText('Matches needle in legacyRef')).toBeDefined();
    expect(within(rowOf('Title W-24')).getByText('Matches needle in primaryRef')).toBeDefined();
    expect(within(rowOf('Title W-00')).getByText('Matches needle in primaryRef')).toBeDefined();
  });
});
