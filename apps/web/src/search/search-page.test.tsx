import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { createClientState } from '../state/client-state.js';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { answerOf, deferred, hit, searchKit, TYPE, searchAt } from './search-test-kit.js';

const ok = (value: SearchResult): ApiResult<SearchResult> => ({ ok: true, value });
const main = () => screen.getByRole('main');
const box = () => within(main()).getByRole('searchbox', { name: 'Search text' });

describe('the Search results page', () => {
  it('searches once and shows the heading, the source note, the badge, the box, the caption, the summary and the group with its rows', async () => {
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [hit('demo', 'AC-1', { status: 'open', tier: 'gold', stableCode: 'AC-1' })])));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' })).toBeDefined();
    expect(kit.searches).toEqual([{ sourceId: 'demo', text: 'AC-1' }]);
    expect(screen.getByRole('heading', { level: 1, name: 'Search results' })).toBeDefined();
    expect(within(main()).getByText('Source demo · read-only')).toBeDefined();
    expect(within(main()).getByText('Synthetic data')).toBeDefined();
    expect(box()).toHaveProperty('value', 'AC-1');
    expect(within(main()).getByText('Searches only configured, indexed properties in Source demo.')).toBeDefined();
    expect(within(main()).getByText('1 exact match · 0.18 s')).toBeDefined();
    const row = within(main()).getByRole('listitem');
    expect(within(row).getByText('KIND-A')).toBeDefined();
    expect(within(row).getByText('Title AC-1')).toBeDefined();
    expect(within(row).getByText('open · AC-1 · gold')).toBeDefined();
    expect(within(row).getByRole('button', { name: /^Open in graph/ })).toBeDefined();
  });

  it('names the searched source and its badge even while an investigation of another source is open', async () => {
    const kit = searchKit(['demo', 'other'], async () => ok(answerOf('demo', [hit('demo', 'AC-1')])), { synthetic: { demo: false, other: true } });
    const state = createClientState();
    state.bindSource('other');
    renderApp(searchAt('demo', 'AC-1'), kit.client, state);
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    expect(within(main()).getByText('Source demo · read-only')).toBeDefined();
    expect(within(main()).queryByText('Synthetic data')).toBeNull();
  });

  it('shows a lower bound as "≥ 25 · lower bound" in the group and the summary, and an exact count as the number alone', async () => {
    const many = Array.from({ length: 25 }, (_, index) => hit('demo', `AC-${index + 1}`));
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', many, { counts: { exact: { value: 25, quality: 'lowerBound', scope: 'search:exact' } } })));
    renderApp(searchAt('demo', 'AC'), kit.client);
    expect(await screen.findByRole('heading', { level: 2, name: 'Exact ID match (≥ 25 · lower bound)' })).toBeDefined();
    expect(within(main()).getByText('≥ 25 exact matches · lower bound · 0.18 s')).toBeDefined();
  });

  it('shows the empty state and keeps the box and its text', async () => {
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [])));
    renderApp(searchAt('demo', 'nothing'), kit.client);
    expect(await screen.findByRole('heading', { level: 2, name: 'No matching entities' })).toBeDefined();
    expect(within(main()).getByText('Check the ID or try another indexed property.')).toBeDefined();
    expect(box()).toHaveProperty('value', 'nothing');
    expect(within(main()).getByText('0 exact matches · 0.18 s')).toBeDefined();
  });

  it('names a type whose search is disabled by its display name, and shows the warnings of the answer', async () => {
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [hit('demo', 'AC-1')], { disabledTypes: [{ entityType: TYPE, reason: 'index-unavailable' }], warnings: ['1 row was left out because they have no usable stable ID.'] })));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await screen.findByText('KIND-A: Search is disabled for this type.')).toBeDefined();
    expect(within(main()).getByText('1 row was left out because they have no usable stable ID.')).toBeDefined();
  });
});

describe('typing a search', () => {
  it('makes a new history entry for the search, sends the text exactly as typed, keeps it out of the address, and the back button shows the earlier search again', async () => {
    const kit = searchKit(['demo'], async (request) => ok(answerOf('demo', [hit('demo', request.text)])));
    const view = renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    const user = userEvent.setup();
    await user.clear(box());
    await user.type(box(), ' ac 2 {Enter}');
    await waitFor(() => expect(kit.searches.at(-1)).toEqual({ sourceId: 'demo', text: ' ac 2 ' }));
    expect(view.router.state.location.search).toBe('?source=demo');
    expect(view.router.state.location.state).toEqual({ q: ' ac 2 ' });
    expect(JSON.stringify(view.router.state.location.pathname + view.router.state.location.search)).not.toContain('ac');
    expect(await screen.findByText('Title ac 2')).toBeDefined();
    await act(() => view.router.navigate(-1));
    expect(await screen.findByText('Title AC-1')).toBeDefined();
    expect(box()).toHaveProperty('value', 'AC-1');
  });

  it('sends the same text on a reload of the entry as on the submit, read from the history state and not from the address', async () => {
    const first = searchKit(['demo'], async () => ok(answerOf('demo', [])));
    const view = renderApp(searchAt('demo', 'AC-1'), first.client);
    await screen.findByRole('heading', { level: 2, name: 'No matching entities' });
    const user = userEvent.setup();
    await user.clear(box());
    await user.type(box(), '  spaced  {Enter}');
    await waitFor(() => expect(first.searches.at(-1)?.text).toBe('  spaced  '));
    const { pathname, search, state } = view.router.state.location;
    expect(search).toBe('?source=demo');
    view.unmount();
    const second = searchKit(['demo'], async () => ok(answerOf('demo', [])));
    renderApp({ pathname, search, state }, second.client);
    await waitFor(() => expect(second.searches).toEqual([{ sourceId: 'demo', text: '  spaced  ' }]));
  });

  it('searches again when the same text is submitted again, with no second history entry, and keeps the earlier results on screen while it waits and when it fails', async () => {
    const second = deferred<ApiResult<SearchResult>>();
    let calls = 0;
    const kit = searchKit(['demo'], () => (calls++ === 0 ? Promise.resolve(ok(answerOf('demo', [hit('demo', 'AC-1')]))) : second.promise));
    const view = renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    const lengthBefore = window.history.length;
    const locationBefore = view.router.state.location.key;
    const user = userEvent.setup();
    await user.click(box());
    await user.keyboard('{Enter}');
    await waitFor(() => expect(kit.searches).toEqual([{ sourceId: 'demo', text: 'AC-1' }, { sourceId: 'demo', text: 'AC-1' }]));
    expect(screen.getByRole('heading', { level: 2, name: 'Exact ID match (1)' })).toBeDefined();
    await act(async () => second.settle({ ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'A fixed message.', retryable: true, traceId: 'tr-9', details: { timeoutMs: 5000 } } }));
    expect(await screen.findByText('Search timed out after 5 s')).toBeDefined();
    expect(screen.getByRole('heading', { level: 2, name: 'Exact ID match (1)' })).toBeDefined();
    expect(view.router.state.location.key).toBe(locationBefore);
    expect(window.history.length).toBe(lengthBefore);
  });

  it('does not send an empty text and says so, and does not change the entry', async () => {
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [hit('demo', 'AC-1')])));
    const view = renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    const user = userEvent.setup();
    await user.clear(box());
    await user.keyboard('{Enter}');
    expect(await within(main()).findByText('Type something to search.')).toBeDefined();
    expect(kit.searches).toHaveLength(1);
    expect(view.router.state.location.search).toBe('?source=demo');
    expect(view.router.state.location.state).toEqual({ q: 'AC-1' });
    expect(within(main()).getByText('Title AC-1')).toBeDefined();
  });

  it('does not send a text of more than 200 characters and says so', async () => {
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [])));
    renderApp(searchAt('demo'), kit.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('searchbox', { name: 'Search text' }));
    await user.paste('a'.repeat(201));
    await user.keyboard('{Enter}');
    expect(await within(main()).findByText('Use at most 200 characters.')).toBeDefined();
    expect(kit.searches).toEqual([]);
  });

  it('sends nothing before a text is typed', async () => {
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [])));
    renderApp(searchAt('demo'), kit.client);
    await screen.findByRole('searchbox', { name: 'Search text' });
    expect(kit.searches).toEqual([]);
  });
});

describe('answers that arrive out of order, and what stays on screen', () => {
  it('never lets the answer of an earlier search replace the answer of a later one', async () => {
    const answers = [deferred<ApiResult<SearchResult>>(), deferred<ApiResult<SearchResult>>()];
    let index = 0;
    const kit = searchKit(['demo'], () => answers[index++]?.promise ?? Promise.reject(new Error('a third search')));
    renderApp(searchAt('demo', 'first'), kit.client);
    const user = userEvent.setup();
    await waitFor(() => expect(kit.searches).toHaveLength(1));
    await user.clear(box());
    await user.type(box(), 'second{Enter}');
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    await act(async () => answers[1]?.settle(ok(answerOf('demo', [hit('demo', 'SECOND')]))));
    await act(async () => answers[0]?.settle(ok(answerOf('demo', [hit('demo', 'FIRST')]))));
    expect(await screen.findByText('Title SECOND')).toBeDefined();
    expect(screen.queryByText('Title FIRST')).toBeNull();
  });

  it('keeps the earlier results, labelled with their text, and a status, until a later search of the same source answers', async () => {
    const second = deferred<ApiResult<SearchResult>>();
    let calls = 0;
    const kit = searchKit(['demo'], () => (calls++ === 0 ? Promise.resolve(ok(answerOf('demo', [hit('demo', 'FIRST')]))) : second.promise));
    renderApp(searchAt('demo', 'first'), kit.client);
    await screen.findByText('Title FIRST');
    const user = userEvent.setup();
    await user.clear(box());
    await user.type(box(), 'second{Enter}');
    expect(await within(main()).findByRole('status')).toHaveProperty('textContent', 'Searching…');
    expect(screen.getByText('Title FIRST')).toBeDefined();
    expect(screen.getByText('Showing results for “first”.')).toBeDefined();
    await act(async () => second.settle(ok(answerOf('demo', [hit('demo', 'SECOND')]))));
    expect(await screen.findByText('Title SECOND')).toBeDefined();
    expect(screen.queryByText('Title FIRST')).toBeNull();
    expect(screen.queryByText('Showing results for “first”.')).toBeNull();
  });

  it('clears the results at once when the mask changes, shows none of the earlier values, and sends the mask with the next search', async () => {
    const second = deferred<ApiResult<SearchResult>>();
    let calls = 0;
    const kit = searchKit(['demo'], () => (calls++ === 0 ? Promise.resolve(ok(answerOf('demo', [hit('demo', 'PLAIN', { status: 'visible-value' })]))) : second.promise));
    const state = createClientState();
    renderApp(searchAt('demo', 'PLAIN'), kit.client, state);
    await screen.findByText('visible-value', { exact: false });
    await act(async () => state.setMask(true));
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    expect(kit.searches[1]).toEqual({ sourceId: 'demo', text: 'PLAIN', mask: true });
    expect(screen.queryByText('visible-value', { exact: false })).toBeNull();
    expect(screen.queryByText('Title PLAIN')).toBeNull();
    await act(async () => second.settle(ok(answerOf('demo', [hit('demo', 'PLAIN', { status: 'masked-value' })]))));
    expect(await screen.findByText('masked-value', { exact: false })).toBeDefined();
  });
});

describe('a page with nothing to search', () => {
  it('says so when no source is configured, and sends nothing', async () => {
    const kit = searchKit([], async () => ok(answerOf('demo', [])));
    renderApp({ pathname: '/search', search: '', state: { q: 'AC-1' } }, kit.client);
    expect(await screen.findByText('No source is configured.')).toBeDefined();
    expect(kit.searches).toEqual([]);
  });

  it('shows the failure of the sources with Try again and sends nothing, then searches when they can be read', async () => {
    let readable = false;
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [hit('demo', 'AC-1')])));
    const client = { ...kit.client, getSources: (signal?: AbortSignal) => (readable ? kit.client.getSources(signal) : Promise.resolve({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } as const)) };
    renderApp(searchAt('demo', 'AC-1'), client);
    expect(await screen.findByText('The sources could not be read.')).toBeDefined();
    expect(kit.searches).toEqual([]);
    readable = true;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Title AC-1')).toBeDefined();
  });

  it('shows the failure of the source profile with Try again and sends nothing', async () => {
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [])));
    const client = { ...kit.client, getProfile: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) as const };
    renderApp(searchAt('demo', 'AC-1'), client);
    expect(await screen.findByText('The source could not be read.')).toBeDefined();
    expect(within(main()).getByRole('button', { name: 'Try again' })).toBeDefined();
    expect(kit.searches).toEqual([]);
  });

  it('says that a source named in the link is not configured, and sends nothing', async () => {
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [])));
    renderApp(searchAt('missing', 'AC-1'), kit.client);
    expect(await screen.findByText('The source “missing” is not configured.')).toBeDefined();
    expect(kit.searches).toEqual([]);
  });

  it('keeps unused helpers honest', () => {
    expect(fakeClient()).toBeDefined();
    expect(clientWith({ me: me(), sources: [source('demo')] })).toBeDefined();
  });
});

describe('a text of one character, a masked search with nothing to search, and the address', () => {
  it('sends a text of one character, which a stable ID can be', async () => {
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [hit('demo', 'X')])));
    renderApp(searchAt('demo'), kit.client);
    await user().click(await within(main()).findByRole('searchbox', { name: 'Search text' }));
    await user().keyboard('X{Enter}');
    await waitFor(() => expect(kit.searches).toEqual([{ sourceId: 'demo', text: 'X' }]));
  });

  it('ignores a q in a link and searches nothing', async () => {
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [hit('demo', 'AC-1')])));
    renderApp('/search?source=demo&q=AC-1', kit.client);
    await screen.findByRole('searchbox', { name: 'Search text' });
    expect(kit.searches).toEqual([]);
    expect(box()).toHaveProperty('value', '');
  });

  it('says that nothing can be searched while personal data is masked, and not "No matching entities", when the session masks and no property is left', async () => {
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [], { searchable: false })));
    const state = createClientState();
    state.setMask(true);
    renderApp(searchAt('demo', 'Ana'), kit.client, state);
    expect(await screen.findByText('Nothing can be searched while personal data is masked.')).toBeDefined();
    expect(screen.queryByText('No matching entities')).toBeNull();
    expect(screen.queryByText(/exact match/)).toBeNull();
  });

  it('does not say it is the mask when the session does not mask and the source configures no property for search', async () => {
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [], { searchable: false })));
    renderApp(searchAt('demo', 'Ana'), kit.client);
    expect(await screen.findByText('No property of this source is configured for search.')).toBeDefined();
    expect(screen.queryByText('Nothing can be searched while personal data is masked.')).toBeNull();
    expect(screen.queryByText('No matching entities')).toBeNull();
  });

  it('reads the number of a lower bound from the count and not from the cap: 10 at a small cap, and 23 when normalization left rows out', async () => {
    const small = searchKit(['demo'], async () => ok(answerOf('demo', Array.from({ length: 10 }, (_, index) => hit('demo', `AC-${index}`)), { cap: 10, counts: { exact: { value: 10, quality: 'lowerBound', scope: 'search:exact' } } })));
    renderApp(searchAt('demo', 'AC'), small.client);
    expect(await screen.findByRole('heading', { level: 2, name: 'Exact ID match (≥ 10 · lower bound)' })).toBeDefined();
    expect(within(main()).getByText('≥ 10 exact matches · lower bound · 0.18 s')).toBeDefined();
    cleanup();
    const reduced = searchKit(['demo'], async () => ok(answerOf('demo', Array.from({ length: 23 }, (_, index) => hit('demo', `AC-${index}`)), { counts: { exact: { value: 23, quality: 'lowerBound', scope: 'search:exact' } } })));
    renderApp(searchAt('demo', 'AC'), reduced.client);
    expect(await screen.findByText('≥ 23 exact matches · lower bound · 0.18 s')).toBeDefined();
  });

  it('lists the types that were left out, and not "No matching entities", when every type is left out', async () => {
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [], { searchable: false, disabledTypes: [{ entityType: 'kind-a', reason: 'index-unavailable' }] })));
    renderApp(searchAt('demo', 'Ana'), kit.client);
    expect(await screen.findByText('KIND-A: Search is disabled for this type.')).toBeDefined();
    expect(screen.queryByText('No matching entities')).toBeNull();
    expect(screen.queryByText('Nothing can be searched while personal data is masked.')).toBeNull();
  });
});

function user() {
  return userEvent.setup();
}
