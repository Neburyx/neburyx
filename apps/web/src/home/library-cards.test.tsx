import { act, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InvestigationListResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, listItemOf, listOf, nodeOf } from '../investigations/test-data.js';
import { renderApp } from '../test-utils.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1'), node: nodeOf('source-a', 'kind-a', 'A-1') };
const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1'), node: nodeOf('source-b', 'kind-a', 'C-1') };
const rowsA = [listItemOf(A.investigation), listItemOf(B.investigation)];

const library = (): HTMLElement => screen.getByRole('group', { name: 'Library' });
const cardOf = (title: string): HTMLElement => {
  const card = within(library()).getByRole('heading', { name: title, level: 3 }).closest('.library-card');
  if (!(card instanceof HTMLElement)) throw new Error(`no card ${title}`);
  return card;
};
const withCounts = (investigations: number, sources: number, hasMore = true): InvestigationListResponse => {
  const base = listOf(rowsA, hasMore);
  return { ...base, counts: { ...base.counts, investigations: { value: investigations, quality: 'exact', scope: 'investigations' }, sources: { value: sources, quality: 'exact', scope: 'investigation-sources' } } };
};
const ok = (value: InvestigationListResponse): ApiResult<InvestigationListResponse> => ({ ok: true, value });
const failure: ApiResult<InvestigationListResponse> = { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };

describe('Home: the Investigations card', () => {
  it('shows the number of investigations and the sources they span, in a group named Library above the Recent list', async () => {
    renderApp('/', knowing([A, B]).client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(within(cardOf('Investigations')).getByText('2')).toBeTruthy();
    expect(within(cardOf('Investigations')).getByText('Across 2 sources')).toBeTruthy();
    const recent = screen.getByRole('heading', { name: 'Recent', level: 2 });
    expect(library().compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says one source in the singular', async () => {
    renderApp('/', knowing([A]).client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(within(cardOf('Investigations')).getByText('Across 1 source')).toBeTruthy();
  });

  it('shows the server\'s totals when they are larger than the rows shown, and a source that none of the rows is on', async () => {
    renderApp('/', knowing([A, B], { listInvestigations: async () => ok(withCounts(7, 3)) }).client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(within(cardOf('Investigations')).getByText('7')).toBeTruthy();
    expect(within(cardOf('Investigations')).getByText('Across 3 sources')).toBeTruthy();
    expect(document.querySelectorAll('.recent-row')).toHaveLength(2);
  });

  it('shows zero for a person with no investigation', async () => {
    renderApp('/', knowing([]).client);
    await screen.findByText('No recent investigations.');
    expect(within(cardOf('Investigations')).getByText('0')).toBeTruthy();
    expect(within(cardOf('Investigations')).getByText('Across 0 sources')).toBeTruthy();
  });

  it('says Loading… and shows no number while the list has never been answered', async () => {
    renderApp('/', knowing([A], { listInvestigations: () => new Promise(() => undefined) }).client);
    await screen.findByText('Loading recent investigations…');
    const card = cardOf('Investigations');
    expect(within(card).getByText('Loading…')).toBeTruthy();
    expect(card.querySelector('.library-figure')).toBeNull();
  });

  it('says Not read and shows no number when the first read failed, and shows the answer after Recent\'s Try again reads once', async () => {
    let reads = 0;
    renderApp('/', knowing([A, B], { listInvestigations: async () => (++reads === 1 ? failure : ok(withCounts(2, 2, false))) }).client);
    await screen.findByText('Recent investigations could not be read.');
    const card = cardOf('Investigations');
    expect(within(card).getByText('Not read')).toBeTruthy();
    expect(card.querySelector('.library-figure')).toBeNull();
    expect(reads).toBe(1);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(cardOf('Investigations')).getByText('Across 2 sources')).toBeTruthy());
    expect(reads).toBe(2);
  });

  it('keeps the earlier figures while the list is read again and when that read fails, and takes the new ones when it succeeds', async () => {
    const answers: Array<ApiResult<InvestigationListResponse> | Promise<ApiResult<InvestigationListResponse>>> = [ok(withCounts(2, 2, false))];
    let release: (result: ApiResult<InvestigationListResponse>) => void = () => undefined;
    const second = new Promise<ApiResult<InvestigationListResponse>>((resolve) => (release = resolve));
    answers.push(second, failure, ok(withCounts(9, 4)));
    let reads = 0;
    renderApp('/', knowing([A, B], { listInvestigations: async () => answers[Math.min(reads++, answers.length - 1)] ?? failure }).client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(within(cardOf('Investigations')).getByText('2')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: /^Sources$/ }));
    await user.click(await screen.findByRole('link', { name: 'Home' }));
    await screen.findByText('Loading recent investigations…');
    expect(within(cardOf('Investigations')).getByText('2')).toBeTruthy();
    await act(async () => release(ok(withCounts(5, 3))));
    await waitFor(() => expect(within(cardOf('Investigations')).getByText('5')).toBeTruthy());
    await user.click(screen.getByRole('link', { name: /^Sources$/ }));
    await user.click(await screen.findByRole('link', { name: 'Home' }));
    await screen.findByText('NETWORK_UNAVAILABLE');
    expect(within(cardOf('Investigations')).getByText('5')).toBeTruthy();
    expect(within(cardOf('Investigations')).getByText('Across 3 sources')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(cardOf('Investigations')).getByText('9')).toBeTruthy());
    expect(within(cardOf('Investigations')).getByText('Across 4 sources')).toBeTruthy();
  });

  it('is neither a link nor a control, and Home sends no request for it beyond the list', async () => {
    const parts = knowing([A, B]);
    renderApp('/', parts.client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(within(cardOf('Investigations')).queryByRole('link')).toBeNull();
    expect(within(cardOf('Investigations')).queryByRole('button')).toBeNull();
    expect(parts.calls).toEqual({ getEntity: [], getInvestigation: [], openInvestigation: [], listInvestigations: [5] });
  });
});

const withViews = (count: number, lastEditedAt: string | null, hasMore = false): InvestigationListResponse => listOf(rowsA, hasMore, rowsA, { count, lastEditedAt });

describe('Home: the Saved views card', () => {
  it('follows the Investigations card and shows the number of named views the server counted', async () => {
    renderApp('/', knowing([A, B], { listInvestigations: async () => ok(withViews(3, '2026-11-05T09:42:00.000Z')) }).client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    const titles = within(library()).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(titles.slice(0, 2)).toEqual(['Investigations', 'Saved views']);
    expect(within(cardOf('Saved views')).getByText('3')).toBeTruthy();
  });

  it('shows the time of the newest named view in UTC when the server sent one', async () => {
    renderApp('/', knowing([A], { listInvestigations: async () => ok(withViews(1, '2026-11-05T23:07:30.000Z')) }).client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(within(cardOf('Saved views')).getByText('Last edited 23:07 UTC')).toBeTruthy();
  });

  it('shows the count and no Last edited line when there is no named view', async () => {
    renderApp('/', knowing([A, B]).client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    const card = cardOf('Saved views');
    expect(within(card).getByText('0')).toBeTruthy();
    expect(card.textContent).not.toContain('Last edited');
  });

  it('says Loading… and then Not read, with no number, before the list has ever been answered', async () => {
    const first = renderApp('/', knowing([A], { listInvestigations: () => new Promise(() => undefined) }).client);
    await screen.findByText('Loading recent investigations…');
    expect(within(cardOf('Saved views')).getByText('Loading…')).toBeTruthy();
    expect(cardOf('Saved views').querySelector('.library-figure')).toBeNull();
    first.unmount();
    renderApp('/', knowing([A], { listInvestigations: async () => failure }).client);
    await screen.findByText('Recent investigations could not be read.');
    expect(within(cardOf('Saved views')).getByText('Not read')).toBeTruthy();
    expect(cardOf('Saved views').querySelector('.library-figure')).toBeNull();
  });

  it('keeps the earlier figure and time while the list is read again and when that read fails', async () => {
    let release: (result: ApiResult<InvestigationListResponse>) => void = () => undefined;
    const reread = new Promise<ApiResult<InvestigationListResponse>>((resolve) => (release = resolve));
    let reads = 0;
    renderApp('/', knowing([A], { listInvestigations: () => (++reads === 1 ? Promise.resolve(ok(withViews(2, '2026-11-05T09:42:00.000Z'))) : reread) }).client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: /^Sources$/ }));
    await user.click(await screen.findByRole('link', { name: 'Home' }));
    await screen.findByText('Loading recent investigations…');
    expect(within(cardOf('Saved views')).getByText('2')).toBeTruthy();
    expect(within(cardOf('Saved views')).getByText('Last edited 09:42 UTC')).toBeTruthy();
    await act(async () => release(failure));
    await screen.findByText('NETWORK_UNAVAILABLE');
    expect(within(cardOf('Saved views')).getByText('2')).toBeTruthy();
    expect(within(cardOf('Saved views')).getByText('Last edited 09:42 UTC')).toBeTruthy();
  });

  it('is neither a link nor a control', async () => {
    renderApp('/', knowing([A]).client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(within(cardOf('Saved views')).queryByRole('link')).toBeNull();
    expect(within(cardOf('Saved views')).queryByRole('button')).toBeNull();
  });
});

describe('Home: the Patterns card', () => {
  it.each([
    ['answered', () => knowing([A, B]).client, 'kind-a A-1'],
    ['loading', () => knowing([A], { listInvestigations: () => new Promise(() => undefined) }).client, 'Loading recent investigations…'],
    ['failed', () => knowing([A], { listInvestigations: async () => failure }).client, 'Recent investigations could not be read.'],
  ])('says built-in patterns are not available yet, with no number, when the list is %s', async (state, client, awaited) => {
    renderApp('/', client());
    await (state === 'answered' ? screen.findByRole('link', { name: awaited }) : screen.findByText(awaited));
    const card = cardOf('Patterns');
    expect(within(card).getByText('Built-in patterns are not available yet.')).toBeTruthy();
    expect(card.querySelector('.library-figure')).toBeNull();
    expect(card.textContent).not.toMatch(/[0-9]/);
  });

  it('is the third card of the group Library, after Investigations and Saved views, and neither a link nor a control', async () => {
    renderApp('/', knowing([A]).client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(within(library()).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Investigations', 'Saved views', 'Patterns']);
    expect(within(cardOf('Patterns')).queryByRole('link')).toBeNull();
    expect(within(cardOf('Patterns')).queryByRole('button')).toBeNull();
  });

  it('causes no request: Home sends only the list, the sources and the identity', async () => {
    const parts = knowing([A, B]);
    renderApp('/', parts.client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(parts.calls).toEqual({ getEntity: [], getInvestigation: [], openInvestigation: [], listInvestigations: [5] });
  });
});
