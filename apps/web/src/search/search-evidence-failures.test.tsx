import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { GroupFailure, SearchResult } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { renderApp } from '../test-utils.js';
import { answerOf, deferred, evidenceHit, hit, relatedOf, searchAt, searchKit } from './search-test-kit.js';

const main = () => screen.getByRole('main');
const ok = (value: SearchResult): ApiResult<SearchResult> => ({ ok: true, value });

const evidenceFailed = (failure: Partial<GroupFailure> = {}, exactHits = [hit('demo', 'AC-1')]): SearchResult =>
  answerOf('demo', exactHits, {
    related: relatedOf([hit('demo', 'REF-1')]),
    evidence: { hits: [], count: { quality: 'unknown', scope: 'search:evidence' }, searchable: true, disabledRelationshipTypes: [] },
    failures: [{ group: 'evidence', code: 'QUERY_TIMEOUT', timeoutMs: 5000, ...failure }],
  });

describe('an evidence read that failed', () => {
  it('keeps the exact and the related group, says in a line that the evidence records were not read, and says in the summary that the group is missing, never as zero', async () => {
    const kit = searchKit(['demo'], async () => ok(evidenceFailed()));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await screen.findByRole('heading', { level: 2, name: 'Exact ID match (1)' })).toBeDefined();
    expect(screen.getByRole('heading', { level: 2, name: 'Related records · Referenced ID (1)' })).toBeDefined();
    expect(within(main()).getByRole('alert').textContent).toBe('Evidence records were not read: the source did not answer within 5 s.');
    expect(within(main()).getByText('1 exact match · 1 related record · evidence records not read · 0.18 s')).toBeDefined();
    expect(screen.queryByText(/0 supporting/)).toBeNull();
    expect(screen.queryByRole('region', { name: /^Evidence records/ })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'No matching entities' })).toBeNull();
  });

  it('keeps the evidence group with its count when the exact read failed', async () => {
    const answer = answerOf('demo', [], {
      counts: { exact: { quality: 'unknown', scope: 'search:exact' } },
      evidence: { hits: [evidenceHit('L-1')], count: { value: 1, quality: 'exact', scope: 'search:evidence' }, searchable: true, disabledRelationshipTypes: [] },
      failures: [{ group: 'exact', code: 'SOURCE_BUSY' }],
    });
    const kit = searchKit(['demo'], async () => ok(answer));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await screen.findByRole('heading', { level: 2, name: 'Evidence records · Supporting relationships (1)' })).toBeDefined();
    expect(within(main()).getByRole('alert').textContent).toBe('Exact matches were not read (SOURCE_BUSY).');
    expect(screen.queryByRole('heading', { level: 2, name: /Exact ID match/ })).toBeNull();
  });

  it('does not read "No matching entities" when the groups that answered are empty and the evidence group failed', async () => {
    const kit = searchKit(['demo'], async () => ok(evidenceFailed({}, [])));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await within(main()).findByRole('alert');
    expect(screen.queryByRole('heading', { level: 2, name: 'No matching entities' })).toBeNull();
  });

  it('says any code other than a timeout by its code', async () => {
    const kit = searchKit(['demo'], async () => ok(evidenceFailed({ code: 'RATE_LIMITED', timeoutMs: undefined })));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect((await within(main()).findByRole('alert')).textContent).toBe('Evidence records were not read (RATE_LIMITED).');
  });

  it('shows Retry, which repeats the whole search, and keeps the earlier answer, labelled, until the repeated one arrives', async () => {
    const second = deferred<ApiResult<SearchResult>>();
    let calls = 0;
    const kit = searchKit(['demo'], () => (calls++ === 0 ? Promise.resolve(ok(evidenceFailed())) : second.promise));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await within(main()).findByRole('alert');
    await userEvent.setup().click(within(main()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    expect(kit.searches[1]).toEqual(kit.searches[0]);
    expect(screen.getByRole('heading', { level: 2, name: 'Exact ID match (1)' })).toBeDefined();
    await act(async () => second.settle(ok(answerOf('demo', [hit('demo', 'AC-1')], { evidence: { hits: [evidenceHit('L-1')], count: { value: 1, quality: 'exact', scope: 'search:evidence' }, searchable: true, disabledRelationshipTypes: [] } }))));
    expect(await screen.findByRole('region', { name: 'Evidence records · Supporting relationships (1)' })).toBeDefined();
    expect(within(main()).queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
