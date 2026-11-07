import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { GraphNode, OpenInvestigationResponse, SearchResult } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { INVESTIGATION_A, investigationOf, knowing, openedOf } from '../investigations/test-data.js';
import { createClientState } from '../state/client-state.js';
import { renderApp, source } from '../test-utils.js';
import { answerOf, deferred, hit, profiled, relatedOf, searchAt, searchKit, TYPE, withRelated } from './search-test-kit.js';

const ok = (value: SearchResult): ApiResult<SearchResult> => ({ ok: true, value });
const main = () => screen.getByRole('main');

describe('the related group on the Search results page', () => {
  it('shows the exact group first, then the related group with its count, its rows and the note under the summary line', async () => {
    const kit = searchKit(['demo'], async () => withRelated('demo', [hit('demo', 'AC-1', { status: 'open' })], [hit('demo', 'REF-1', { status: 'held' }), hit('demo', 'REF-2')]));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    const headings = await screen.findAllByRole('heading', { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual(['Exact ID match (1)', 'Related records · Referenced ID (2)']);
    expect(within(main()).getByText('1 exact match · 2 related records · 0.18 s')).toBeDefined();
    const note = within(main()).getByText('Related records reference the ID; they are not extra exact matches.');
    const summary = within(main()).getByText('1 exact match · 2 related records · 0.18 s');
    expect(summary.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const group = screen.getByRole('region', { name: 'Related records · Referenced ID (2)' });
    const rows = within(group).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('Title REF-1')).toBeDefined();
    expect(within(rows[0] as HTMLElement).getByText('KIND-A')).toBeDefined();
    expect(within(rows[0] as HTMLElement).getByText('held')).toBeDefined();
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: /^Open in graph/ })).toBeDefined();
  });

  it('says a single related record in the singular', async () => {
    const kit = searchKit(['demo'], async () => withRelated('demo', [hit('demo', 'AC-1')], [hit('demo', 'REF-1')]));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await within(main()).findByText('1 exact match · 1 related record · 0.18 s')).toBeDefined();
  });

  it('shows a lower bound in the heading and the summary and never adds the related count to the exact count', async () => {
    const many = Array.from({ length: 25 }, (_, index) => hit('demo', `REF-${index + 1}`));
    const kit = searchKit(['demo'], async () => withRelated('demo', [hit('demo', 'AC-1')], many, { value: 25, quality: 'lowerBound', scope: 'search:related' }));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await screen.findByRole('heading', { level: 2, name: 'Related records · Referenced ID (≥ 25 · lower bound)' })).toBeDefined();
    expect(within(main()).getByText('1 exact match · ≥ 25 related records · lower bound · 0.18 s')).toBeDefined();
    expect(screen.getByRole('heading', { level: 2, name: 'Exact ID match (1)' })).toBeDefined();
  });

  it('shows the heading with the count as the answer holds it, when normalization left a capped read with fewer than the cap', async () => {
    const kit = searchKit(['demo'], async () => withRelated('demo', [], [hit('demo', 'REF-1'), hit('demo', 'REF-2'), hit('demo', 'REF-3')], { value: 3, quality: 'lowerBound', scope: 'search:related' }));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await screen.findByRole('heading', { level: 2, name: 'Related records · Referenced ID (≥ 3 · lower bound)' })).toBeDefined();
  });

  it('shows the related group and not the exact group, and no empty state, when only related records were found', async () => {
    const kit = searchKit(['demo'], async () => withRelated('demo', [], [hit('demo', 'REF-1')]));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await screen.findByRole('heading', { level: 2, name: 'Related records · Referenced ID (1)' })).toBeDefined();
    expect(screen.queryByRole('heading', { level: 2, name: /Exact ID match/ })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'No matching entities' })).toBeNull();
    expect(within(main()).getByText('0 exact matches · 1 related record · 0.18 s')).toBeDefined();
  });

  it('reaches Open in graph of each related row by keyboard, with an accessible name that includes the entity title, in reading order', async () => {
    const kit = searchKit(['demo'], async () => withRelated('demo', [hit('demo', 'AC-1')], [hit('demo', 'REF-1'), hit('demo', 'REF-2')]));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByRole('heading', { level: 2, name: /Related records/ });
    const buttons = within(main()).getAllByRole('button', { name: /^Open in graph/ });
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Open in graph: Title AC-1', 'Open in graph: Title REF-1', 'Open in graph: Title REF-2']);
    expect(within(main()).getByRole('button', { name: 'Open in graph: Title REF-2' })).toBe(buttons[2]);
    const user = userEvent.setup();
    await user.click(within(main()).getByRole('button', { name: 'Search' }));
    await user.tab();
    expect(document.activeElement).toBe(buttons[0]);
    await user.tab();
    expect(document.activeElement).toBe(buttons[1]);
  });
});

describe('the context line of a related record', () => {
  it('says which properties of the record hold the searched text, and only "Referenced ID" when none can be named', async () => {
    const kit = searchKit(['demo'], async () => ({
      ok: true,
      value: answerOf('demo', [hit('demo', 'AC-1')], { related: relatedOf([hit('demo', 'REF-1'), hit('demo', 'REF-2')], undefined, { 'REF-1': ['batchRef', 'ownerRef'] }) }),
    }));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    const group = await screen.findByRole('region', { name: 'Related records · Referenced ID (2)' });
    const rows = within(group).getAllByRole('listitem');
    expect(within(rows[0] as HTMLElement).getByText('References AC-1 in batchRef, ownerRef')).toBeDefined();
    expect(within(rows[1] as HTMLElement).getByText('Referenced ID')).toBeDefined();
    expect(within(screen.getByRole('region', { name: 'Exact ID match (1)' })).queryByText(/References/)).toBeNull();
  });

  it('uses the text that was answered and not the text now in the box while a newer search is pending', async () => {
    const second = deferred<ApiResult<SearchResult>>();
    let calls = 0;
    const kit = searchKit(['demo'], () => (calls++ === 0 ? Promise.resolve({ ok: true, value: answerOf('demo', [], { related: relatedOf([hit('demo', 'REF-1')], undefined, { 'REF-1': ['batchRef'] }) }) }) : second.promise));
    renderApp(searchAt('demo', 'first'), kit.client);
    await screen.findByText('References first in batchRef');
    const user = userEvent.setup();
    const box = within(main()).getByRole('searchbox', { name: 'Search text' });
    await user.clear(box);
    await user.type(box, 'second{Enter}');
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    expect(screen.getByText('References first in batchRef')).toBeDefined();
    expect(screen.queryByText(/References second/)).toBeNull();
  });
});

describe('a type left out of the related group', () => {
  it('is named under the summary with its own message, beside the notes of the exact group', async () => {
    const left = { entityType: TYPE, property: 'ref', reason: 'index-unavailable' as const, typeSearched: true };
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [hit('demo', 'AC-1')], { disabledTypes: [left], related: { ...relatedOf([hit('demo', 'REF-1')]), disabledTypes: [{ ...left, reason: 'index-building' }] } })));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await screen.findByText('Not searched for related records: KIND-A · ref: index is building')).toBeDefined();
    expect(within(main()).getByText('Not searched: KIND-A · ref: no online index')).toBeDefined();
  });

  it('is named, with the reason the group was not searched left out, when every type was left out', async () => {
    const left = { entityType: TYPE, property: 'ref', reason: 'index-failed' as const, typeSearched: false };
    const kit = searchKit(['demo'], async () => ok(answerOf('demo', [hit('demo', 'AC-1')], { related: { hits: [], count: { value: 0, quality: 'exact', scope: 'search:related' }, searchable: false, disabledTypes: [left] } })));
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    expect(await screen.findByText('Not searched for related records: KIND-A, none of its properties · ref: index failed')).toBeDefined();
    expect(within(main()).queryByText('No property of this source is configured for related records.')).toBeNull();
    expect(within(main()).getByText('1 exact match · 0.18 s')).toBeDefined();
  });
});

describe('opening a related record', () => {
  const account = { investigation: investigationOf(INVESTIGATION_A, 'demo', TYPE, 'REF-1'), node: hit('demo', 'REF-1') };
  const rig = (overrides: Parameters<typeof knowing>[1] = {}) =>
    knowing([account], {
      getSources: async () => ({ ok: true, value: { items: [source('demo')], nextCursor: null } }),
      getProfile: async (sourceId) => ({ ok: true, value: profiled(sourceId) }),
      searchEntities: async (request) => withRelated(request.sourceId, [], [hit(request.sourceId, 'REF-1')]),
      ...overrides,
    });

  it('opens the entity of the related row with the session mask, by the keyboard as well as the mouse', async () => {
    const { client } = rig();
    const view = renderApp(searchAt('demo', 'AC-1'), client);
    const button = await within(main()).findByRole('button', { name: /^Open in graph/ });
    button.focus();
    await userEvent.setup().keyboard('{Enter}');
    await waitFor(() => expect(view.router.state.location.pathname).toBe(`/explore/${INVESTIGATION_A}`));
    expect(view.state.investigation.getState()).toMatchObject({ id: INVESTIGATION_A, nodeRefs: [{ sourceId: 'demo', entityType: TYPE, stableId: 'REF-1' }], edgeRefs: [] });
  });

  it('leaves the page as it was when the entity cannot be opened', async () => {
    const { client } = rig({ openInvestigation: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    const view = renderApp(searchAt('demo', 'AC-1'), client);
    await userEvent.setup().click(await within(main()).findByRole('button', { name: /^Open in graph/ }));
    expect(await screen.findByRole('group', { name: 'Opening failed' })).toBeDefined();
    expect(view.router.state.location.pathname).toBe('/search');
    expect(screen.getByRole('heading', { level: 2, name: 'Related records · Referenced ID (1)' })).toBeDefined();
  });

  it('does not navigate when the mask changes while the open is under way', async () => {
    const pending = deferred<ApiResult<OpenInvestigationResponse>>();
    const { client } = rig({ openInvestigation: () => pending.promise });
    const state = createClientState();
    const view = renderApp(searchAt('demo', 'AC-1'), client, state);
    await userEvent.setup().click(await within(main()).findByRole('button', { name: /^Open in graph/ }));
    await act(async () => state.setMask(true));
    await act(async () => pending.settle({ ok: true, value: openedOf(account.investigation, account.node) }));
    expect(view.router.state.location.pathname).toBe('/search');
    expect(state.investigation.getState().id).toBeNull();
  });
});

describe('a newer related answer', () => {
  it('keeps both groups of the earlier answer, labelled, until a later search of the same source and mask answers, and a stale answer never replaces a newer one', async () => {
    const answers = [deferred<ApiResult<SearchResult>>(), deferred<ApiResult<SearchResult>>(), deferred<ApiResult<SearchResult>>()];
    let calls = 0;
    const kit = searchKit(['demo'], () => answers[calls++]?.promise ?? Promise.reject(new Error('no answer')));
    renderApp(searchAt('demo', 'first'), kit.client);
    await act(async () => answers[0]?.settle(withRelated('demo', [hit('demo', 'FIRST')], [hit('demo', 'REL-FIRST')])));
    await screen.findByText('Title REL-FIRST');
    const user = userEvent.setup();
    const box = () => within(main()).getByRole('searchbox', { name: 'Search text' });
    await user.clear(box());
    await user.type(box(), 'second{Enter}');
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    await user.clear(box());
    await user.type(box(), 'third{Enter}');
    await waitFor(() => expect(kit.searches).toHaveLength(3));
    expect(screen.getByText('Title FIRST')).toBeDefined();
    expect(screen.getByText('Title REL-FIRST')).toBeDefined();
    expect(screen.getByText('Showing results for “first”.')).toBeDefined();
    await act(async () => answers[2]?.settle(withRelated('demo', [hit('demo', 'THIRD')], [hit('demo', 'REL-THIRD')])));
    await act(async () => answers[1]?.settle(withRelated('demo', [hit('demo', 'SECOND')], [hit('demo', 'REL-SECOND')])));
    expect(await screen.findByText('Title REL-THIRD')).toBeDefined();
    expect(screen.queryByText('Title REL-SECOND')).toBeNull();
    expect(screen.queryByText('Title REL-FIRST')).toBeNull();
  });

  it('clears both groups at once when the mask changes and ignores a late answer of the earlier mask', async () => {
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
    expect(kit.searches[1]).toEqual({ sourceId: 'demo', text: 'AC-1', mask: true });
    await act(async () => later.settle(withRelated('demo', [], [hit('demo', 'REL-MASKED', { status: 'masked-value' })])));
    expect(await screen.findByText('masked-value', { exact: false })).toBeDefined();
    await act(async () => earlier.settle(withRelated('demo', [], [hit('demo', 'REL-LATE', { status: 'visible-value' })])));
    expect(screen.queryByText('Title REL-LATE')).toBeNull();
    expect(screen.queryByText('visible-value', { exact: false })).toBeNull();
    expect(screen.getByText('Title REL-MASKED')).toBeDefined();
  });

  it('shows none of the answer of the earlier mask while the answer of the new one is pending', async () => {
    const next = deferred<ApiResult<SearchResult>>();
    let calls = 0;
    const kit = searchKit(['demo'], () => (calls++ === 0 ? Promise.resolve(withRelated('demo', [hit('demo', 'AC-1')], [hit('demo', 'REL-PLAIN', { status: 'visible-value' })])) : next.promise));
    const state = createClientState();
    renderApp(searchAt('demo', 'AC-1'), kit.client, state);
    await screen.findByText('visible-value', { exact: false });
    await act(async () => state.setMask(true));
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    expect(screen.queryByText('visible-value', { exact: false })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: /Related records|Exact ID match/ })).toBeNull();
    await act(async () => next.settle(withRelated('demo', [], [])));
  });
});
