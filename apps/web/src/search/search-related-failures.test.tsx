import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { GroupFailure, SearchResult } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { createClientState } from '../state/client-state.js';
import { renderApp } from '../test-utils.js';
import { answerOf, deferred, hit, relatedOf, searchAt, searchKit } from './search-test-kit.js';

const main = () => screen.getByRole('main');
const ok = (value: SearchResult): ApiResult<SearchResult> => ({ ok: true, value });

const relatedFailed = (failure: Partial<GroupFailure> = {}, exactHits = [hit('demo', 'AC-1')]): SearchResult =>
  answerOf('demo', exactHits, {
    related: { ...relatedOf([]), count: { quality: 'unknown', scope: 'search:related' } },
    failures: [{ group: 'related', code: 'QUERY_TIMEOUT', timeoutMs: 5000, ...failure }],
  });

const exactFailed = (failure: Partial<GroupFailure> = {}, relatedHits = [hit('demo', 'REF-1'), hit('demo', 'REF-2')]): SearchResult =>
  answerOf('demo', [], {
    counts: { exact: { quality: 'unknown', scope: 'search:exact' } },
    related: relatedOf(relatedHits),
    failures: [{ group: 'exact', code: 'QUERY_TIMEOUT', timeoutMs: 5000, ...failure }],
  });

describe('a group whose read failed', () => {
  it('keeps the exact group with its count, says in a line that the related records were not read, and says in the summary that the group is missing, never as zero', async () => {
    const kit = searchKit(['demo'], async () => ok(relatedFailed()));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' })).toBeDefined();
    expect(within(main()).getByRole('alert').textContent).toBe('Related records were not read: the source did not answer within 5 s.');
    expect(within(main()).getByText('1 exact match · related records not read · 0.18 s')).toBeDefined();
    expect(screen.queryByText(/0 related/)).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: /Related records/ })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'No matching entities' })).toBeNull();
  });

  it('keeps the related group with its count when the exact read failed, and does not show the exact group as empty', async () => {
    const kit = searchKit(['demo'], async () => ok(exactFailed({ code: 'SOURCE_BUSY', timeoutMs: undefined })));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await screen.findByRole('heading', { level: 2, name: 'Related records · Referenced ID (2)' })).toBeDefined();
    expect(within(main()).getByRole('alert').textContent).toBe('Exact matches were not read (SOURCE_BUSY).');
    expect(within(main()).getByText('exact matches not read · 2 related records · 0.18 s')).toBeDefined();
    expect(screen.queryByRole('heading', { level: 2, name: /Exact ID match/ })).toBeNull();
    expect(screen.queryByText(/0 exact/)).toBeNull();
  });

  it('does not read "No matching entities" when the group that answered is empty and the other failed', async () => {
    const kit = searchKit(['demo'], async () => ok(relatedFailed({}, [])));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await within(main()).findByRole('alert');
    expect(screen.queryByRole('heading', { level: 2, name: 'No matching entities' })).toBeNull();
    expect(within(main()).getByText('0 exact matches · related records not read · 0.18 s')).toBeDefined();
  });

  it('says a timeout without a budget in plain words, and any other code by its code', async () => {
    const kit = searchKit(['demo'], async () => ok(relatedFailed({ timeoutMs: undefined })));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect((await within(main()).findByRole('alert')).textContent).toBe('Related records were not read: the source did not answer in time.');
  });

  it('shows Retry, which repeats the whole search, and keeps the earlier answer, labelled, until the repeated one arrives', async () => {
    const second = deferred<ApiResult<SearchResult>>();
    let calls = 0;
    const kit = searchKit(['demo'], () => (calls++ === 0 ? Promise.resolve(ok(relatedFailed())) : second.promise));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await within(main()).findByRole('alert');
    await userEvent.setup().click(within(main()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    expect(kit.searches[1]).toEqual(kit.searches[0]);
    expect(within(main()).getByRole('alert')).toBeDefined();
    expect(screen.getByRole('heading', { level: 2, name: 'Exact ID match (1)' })).toBeDefined();
    await act(async () => second.settle(ok(answerOf('demo', [hit('demo', 'AC-1')], { related: relatedOf([hit('demo', 'REF-1')]) }))));
    expect(await screen.findByRole('heading', { level: 2, name: 'Related records · Referenced ID (1)' })).toBeDefined();
    expect(within(main()).queryByRole('alert')).toBeNull();
    expect(within(main()).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('clears an answer with a failed group at once when the mask changes, and ignores a late answer of the earlier mask', async () => {
    const earlier = deferred<ApiResult<SearchResult>>();
    const later = deferred<ApiResult<SearchResult>>();
    const answers = [earlier, later];
    let calls = 0;
    const kit = searchKit(['demo'], () => answers[calls++]?.promise ?? Promise.reject(new Error('no answer')));
    const state = createClientState();
    renderApp(searchAt('demo', 'AC-1'), kit.client, state);
    await waitFor(() => expect(kit.searches).toHaveLength(1));
    await act(async () => state.setMask(true));
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    await act(async () => later.settle(ok(answerOf('demo', [hit('demo', 'AC-1')]))));
    expect(await screen.findByText('Title AC-1')).toBeDefined();
    await act(async () => earlier.settle(ok(relatedFailed())));
    expect(within(main()).queryByRole('alert')).toBeNull();
    expect(within(main()).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByText('Title AC-1')).toBeDefined();
  });

  it('shows an answer with a failed group of the earlier mask for none of the time the new one is pending', async () => {
    const next = deferred<ApiResult<SearchResult>>();
    let calls = 0;
    const kit = searchKit(['demo'], () => (calls++ === 0 ? Promise.resolve(ok(relatedFailed())) : next.promise));
    const state = createClientState();
    renderApp(searchAt('demo', 'AC-1'), kit.client, state);
    await within(main()).findByRole('alert');
    await act(async () => state.setMask(true));
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    expect(within(main()).queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Title AC-1')).toBeNull();
    await act(async () => next.settle(ok(answerOf('demo', []))));
  });

  it('keeps the page of a whole failure as it was: the failure state with Retry and no group', async () => {
    const failure: ApiResult<SearchResult> = { ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'A fixed message.', retryable: true, traceId: 'tr-1', details: { timeoutMs: 5000 } } };
    const kit = searchKit(['demo'], async () => failure);
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await screen.findByText('Search timed out after 5 s')).toBeDefined();
    expect(within(main()).getByRole('button', { name: 'Retry' })).toBeDefined();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });
});
