import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { renderApp } from '../test-utils.js';
import { answerOf, deferred, hit, searchKit, searchAt } from './search-test-kit.js';

const main = () => screen.getByRole('main');
const box = () => within(main()).getByRole('searchbox', { name: 'Search text' });
const retryButton = () => within(main()).getByRole('button', { name: 'Retry' });

const ok = (value: SearchResult): ApiResult<SearchResult> => ({ ok: true, value });
const server = (code: 'QUERY_TIMEOUT' | 'SOURCE_BUSY' | 'SOURCE_UNAVAILABLE' | 'QUERY_BUDGET_EXCEEDED', details?: { readonly maxPage?: number; readonly timeoutMs?: number }): ApiResult<never> => ({
  ok: false,
  failure: { code, message: 'A fixed message.', retryable: true, traceId: 'tr-9', ...(details === undefined ? {} : { details }) },
});
const down: ApiResult<never> = { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };

describe('a search that timed out', () => {
  it('says how long the source allows, that the graph was not changed, and offers Retry, with the earlier results and the text still on screen', async () => {
    let calls = 0;
    const kit = searchKit(['demo'], async () => (calls++ === 0 ? ok(answerOf('demo', [hit('demo', 'FIRST')])) : server('QUERY_TIMEOUT', { timeoutMs: 5000 })));
    renderApp(searchAt('demo', 'first'), kit.client);
    await screen.findByText('Title FIRST');
    const user = userEvent.setup();
    await user.clear(box());
    await user.type(box(), 'second{Enter}');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Search timed out after 5 s')).toBeDefined();
    expect(within(alert).getByText('Your graph was not changed.')).toBeDefined();
    expect(retryButton()).toBeDefined();
    expect(screen.getByText('Title FIRST')).toBeDefined();
    expect(screen.getByText('Showing results for “first”.')).toBeDefined();
    expect(box()).toHaveProperty('value', 'second');
  });

  it('says the timeout without a number when the error does not carry one, and in seconds with a fraction when it is not whole', async () => {
    const kit = searchKit(['demo'], async () => server('QUERY_TIMEOUT'));
    renderApp(searchAt('demo', 'first'), kit.client);
    expect(await screen.findByText('Search timed out')).toBeDefined();
    const other = searchKit(['demo'], async () => server('QUERY_TIMEOUT', { timeoutMs: 2500 }));
    renderApp(searchAt('demo', 'first'), other.client);
    expect(await screen.findByText('Search timed out after 2.5 s')).toBeDefined();
  });

  it('repeats the same search once with the same source, text and mask when Retry is pressed, and on success replaces the notice and the results', async () => {
    let calls = 0;
    const kit = searchKit(['demo'], async () => (calls++ === 0 ? server('QUERY_TIMEOUT', { timeoutMs: 5000 }) : ok(answerOf('demo', [hit('demo', 'AC-1')]))));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await user().click(await within(main()).findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Title AC-1')).toBeDefined();
    expect(kit.searches).toEqual([
      { sourceId: 'demo', text: 'AC-1' },
      { sourceId: 'demo', text: 'AC-1' },
    ]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

function user() {
  return userEvent.setup();
}

describe('a search that failed another way', () => {
  it.each([
    ['SOURCE_BUSY', server('SOURCE_BUSY'), 'SOURCE_BUSY · trace tr-9'],
    ['SOURCE_UNAVAILABLE', server('SOURCE_UNAVAILABLE'), 'SOURCE_UNAVAILABLE · trace tr-9'],
    ['QUERY_BUDGET_EXCEEDED', server('QUERY_BUDGET_EXCEEDED', { maxPage: 10 }), 'QUERY_BUDGET_EXCEEDED · trace tr-9'],
    ['a network failure', down, 'NETWORK_UNAVAILABLE'],
  ])('shows the code of %s, the trace ID only when the error carries one, and Retry, and keeps the earlier results', async (_name, failure, shown) => {
    let calls = 0;
    const kit = searchKit(['demo'], async () => (calls++ === 0 ? ok(answerOf('demo', [hit('demo', 'FIRST')])) : failure));
    renderApp(searchAt('demo', 'first'), kit.client);
    await screen.findByText('Title FIRST');
    await user().clear(box());
    await user().type(box(), 'second{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe(shown);
    expect(within(main()).getByText('Your graph was not changed.')).toBeDefined();
    expect(retryButton()).toBeDefined();
    expect(screen.getByText('Title FIRST')).toBeDefined();
  });

  it('shows the failure of a first search with no results and the text in the box', async () => {
    const kit = searchKit(['demo'], async () => server('SOURCE_BUSY'));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect((await screen.findByRole('alert')).textContent).toBe('SOURCE_BUSY · trace tr-9');
    expect(box()).toHaveProperty('value', 'AC-1');
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });
});

describe('failures and newer searches', () => {
  it('does not show the failure of an earlier search that arrives after a later search answered', async () => {
    const answers = [deferred<ApiResult<SearchResult>>(), deferred<ApiResult<SearchResult>>()];
    let index = 0;
    const kit = searchKit(['demo'], () => answers[index++]?.promise ?? Promise.reject(new Error('a third search')));
    renderApp(searchAt('demo', 'first'), kit.client);
    await waitFor(() => expect(kit.searches).toHaveLength(1));
    await user().clear(box());
    await user().type(box(), 'second{Enter}');
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    await act(async () => answers[1]?.settle(ok(answerOf('demo', [hit('demo', 'SECOND')]))));
    await act(async () => answers[0]?.settle(server('SOURCE_BUSY')));
    expect(await screen.findByText('Title SECOND')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the notice and Retry by keyboard', () => {
  it('announces the failure, reaches Retry with the keyboard, repeats the search with Enter, and does not lose the focus', async () => {
    let calls = 0;
    const kit = searchKit(['demo'], async () => (calls++ === 0 ? server('QUERY_TIMEOUT', { timeoutMs: 5000 }) : ok(answerOf('demo', [hit('demo', 'AC-1')]))));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await screen.findByRole('alert')).toBeDefined();
    const typing = userEvent.setup();
    await typing.click(box());
    await typing.tab();
    await typing.tab();
    expect(document.activeElement).toBe(retryButton());
    await typing.keyboard('{Enter}');
    expect(await screen.findByText('Title AC-1')).toBeDefined();
    expect(document.activeElement).not.toBe(document.body);
    expect(main().contains(document.activeElement)).toBe(true);
  });
});
