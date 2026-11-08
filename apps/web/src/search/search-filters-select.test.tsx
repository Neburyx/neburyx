import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { renderApp } from '../test-utils.js';
import { addressOf, selectionOf } from './selection.js';
import { answerOf, deferred, FACETS_FAILURE, FAILED_FACETS, facetsOf, hit, profiled, searchAt, searchKit, withFacets } from './search-test-kit.js';

const TYPES = ['kind-a', 'kind-b'] as const;
const main = () => screen.getByRole('main');
const panel = () => within(screen.getByRole('complementary', { name: 'Filters' }));
const FULL = facetsOf({ total: 5, types: [['kind-a', 3], ['kind-b', 2]], modes: [['exact', 4], ['related', 1], ['evidence', 7]] });
const answering = () => async () => withFacets('demo', [hit('demo', 'AC-1')], FULL);
const box = () => screen.getByRole('checkbox', { name: /KIND-A/ });

const render = async (selection = '', types: readonly string[] = TYPES, text: string | null = 'AC') => {
  const kit = searchKit(['demo'], answering(), { types });
  const view = renderApp(searchAt('demo', text ?? undefined, selection), kit.client);
  if (text !== null) await screen.findByRole('complementary', { name: 'Filters' });
  return { kit, view };
};

describe('choosing an entry of the Filters', () => {
  it('puts the name in the address, sends the selection with the typed text kept in the history entry, and never puts the text in the address', async () => {
    const { kit, view } = await render();
    await userEvent.setup().click(box());
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    expect(kit.searches[1]).toEqual({ sourceId: 'demo', text: 'AC', entityTypes: ['kind-a'] });
    expect(view.router.state.location.search).toBe('?source=demo&type=kind-a');
    expect(view.router.state.location.state).toEqual({ q: 'AC' });
    expect(view.router.state.location.search).not.toContain('AC');
    expect(view.router.state.location.pathname).not.toContain('AC');
  });

  it('puts the types in the order of the profile and the modes in the order of the modes, however they were chosen', async () => {
    const { kit, view } = await render();
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: /Evidence record/ }));
    await user.click(screen.getByRole('checkbox', { name: /KIND-B/ }));
    await user.click(screen.getByRole('checkbox', { name: /Exact ID/ }));
    await user.click(screen.getByRole('checkbox', { name: /KIND-A/ }));
    await waitFor(() => expect(kit.searches).toHaveLength(5));
    expect(view.router.state.location.search).toBe('?source=demo&type=kind-a&type=kind-b&mode=exact&mode=evidence');
    expect(kit.searches[4]).toEqual({ sourceId: 'demo', text: 'AC', entityTypes: ['kind-a', 'kind-b'], matchModes: ['exact', 'evidence'] });
  });

  it('omits the fields, and does not send an empty list, when the last box is unchecked', async () => {
    const { kit, view } = await render('&type=kind-a');
    await userEvent.setup().click(box());
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    expect(kit.searches[1]).toEqual({ sourceId: 'demo', text: 'AC' });
    expect(Object.keys(kit.searches[1] ?? {})).not.toContain('entityTypes');
    expect(view.router.state.location.search).toBe('?source=demo');
  });

  it('draws Reset as a link while something is chosen and not otherwise, and Reset clears both lists and searches again', async () => {
    const { kit, view } = await render('&type=kind-a&mode=exact');
    const reset = panel().getByRole('button', { name: 'Reset' });
    expect(reset.className).toContain('link');
    await userEvent.setup().click(reset);
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    expect(kit.searches[1]).toEqual({ sourceId: 'demo', text: 'AC' });
    expect(view.router.state.location.search).toBe('?source=demo');
    await waitFor(() => expect(panel().queryByRole('button', { name: 'Reset' })).toBeNull());
  });

  it('is its own history entry, and Back shows the earlier selection and searches it with its text', async () => {
    const { kit, view } = await render();
    await userEvent.setup().click(box());
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    await act(async () => void (await view.router.navigate(-1)));
    await waitFor(() => expect(kit.searches).toHaveLength(3));
    expect(kit.searches[2]).toEqual({ sourceId: 'demo', text: 'AC' });
    expect(view.router.state.location.search).toBe('?source=demo');
    expect(view.router.state.location.state).toEqual({ q: 'AC' });
    expect(box()).toHaveProperty('checked', false);
  });

  it('keeps the selection when a new text is submitted, and drops it when the source changes', async () => {
    const { kit, view } = await render('&type=kind-b');
    const user = userEvent.setup();
    const field = screen.getByRole('searchbox', { name: 'Search text' });
    await user.clear(field);
    await user.type(field, 'XY{Enter}');
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    expect(kit.searches[1]).toEqual({ sourceId: 'demo', text: 'XY', entityTypes: ['kind-b'] });
    expect(view.router.state.location.search).toBe('?source=demo&type=kind-b');
    expect(view.router.state.location.state).toEqual({ q: 'XY' });
  });
});

describe('the selection of an address', () => {
  it('is checked and sent as it stands, ignoring a name the profile does not know and counting a name given twice once', async () => {
    const { kit } = await render('&type=kind-b&type=kind-b&type=nothing&mode=exact&mode=exact&mode=startsWith');
    expect(kit.searches[0]).toEqual({ sourceId: 'demo', text: 'AC', entityTypes: ['kind-b'], matchModes: ['exact'] });
    expect(screen.getByRole('checkbox', { name: /KIND-B/ })).toHaveProperty('checked', true);
  });

  it('is restored without a search when the address has no text, and the next text is searched with it', async () => {
    const { kit, view } = await render('&type=kind-a&mode=related', TYPES, null);
    await within(main()).findByRole('searchbox', { name: 'Search text' });
    expect(kit.searches).toEqual([]);
    const user = userEvent.setup();
    await user.type(screen.getByRole('searchbox', { name: 'Search text' }), 'ZZ{Enter}');
    await waitFor(() => expect(kit.searches).toHaveLength(1));
    expect(kit.searches[0]).toEqual({ sourceId: 'demo', text: 'ZZ', entityTypes: ['kind-a'], matchModes: ['related'] });
    expect(view.router.state.location.search).toBe('?source=demo&type=kind-a&mode=related');
  });

  it('round-trips names with reserved characters and Unicode, and reads no text from the address', () => {
    const profile = profiled('demo', ['kind é&=/x', 'plain']);
    const selection = { entityTypes: ['kind é&=/x', 'plain'], matchModes: ['exact' as const] };
    const address = addressOf('demo', selection);
    expect(address.toString()).toBe('source=demo&type=kind+%C3%A9%26%3D%2Fx&type=plain&mode=exact');
    expect(selectionOf(new URLSearchParams(address.toString()), profile)).toEqual(selection);
    expect(selectionOf(new URLSearchParams('source=demo&q=AC-1&text=AC-1'), profile)).toEqual({ entityTypes: [], matchModes: [] });
  });

  it('reaches a type with reserved characters through a real address', async () => {
    const { kit } = await render(`&type=${encodeURIComponent('kind é&=/x')}`, ['kind-a', 'kind é&=/x']);
    expect(kit.searches[0]).toEqual({ sourceId: 'demo', text: 'AC', entityTypes: ['kind é&=/x'] });
  });
});

describe('a new selection loading', () => {
  it('keeps the panel with the counts of the last answer, marks it busy, shows no row of the former selection and ignores a late answer of an earlier selection', async () => {
    const first = deferred<ApiResult<SearchResult>>();
    const second = deferred<ApiResult<SearchResult>>();
    let calls = 0;
    const kit = searchKit(['demo'], () => (calls++ === 0 ? Promise.resolve(withFacets('demo', [hit('demo', 'AC-1')], FULL)) : calls === 2 ? first.promise : second.promise), { types: TYPES });
    renderApp(searchAt('demo', 'AC'), kit.client);
    await within(main()).findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    const user = userEvent.setup();
    await user.click(box());
    expect(panel().getByText('5 entities · 7 supporting relationships')).toBeDefined();
    expect(screen.getByRole('complementary', { name: 'Filters' }).getAttribute('aria-busy')).toBe('true');
    expect(within(main()).queryByRole('heading', { level: 2, name: 'Exact ID match (1)' })).toBeNull();
    expect(within(main()).getByText('Searching…')).toBeDefined();
    await user.click(screen.getByRole('checkbox', { name: /KIND-B/ }));
    await act(async () => second.settle(withFacets('demo', [hit('demo', 'BT-1')], facetsOf({ total: 2, types: [['kind-a', 0], ['kind-b', 2]] }))));
    await within(main()).findByText('Title BT-1');
    await act(async () => first.settle(withFacets('demo', [hit('demo', 'A-1')], FULL)));
    expect(within(main()).queryByText('Title A-1')).toBeNull();
    expect(within(main()).getByText('Title BT-1')).toBeDefined();
  });

  it('keeps the form, the panel and the selection when the search of a selection fails, and Retry repeats the same selection', async () => {
    let calls = 0;
    const kit = searchKit(['demo'], async () => (calls++ === 1 ? { ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'A fixed message.', retryable: true, traceId: 'tr-9', details: { timeoutMs: 5000 } } } : withFacets('demo', [hit('demo', 'AC-1')], FULL)), { types: TYPES });
    renderApp(searchAt('demo', 'AC'), kit.client);
    await screen.findByRole('complementary', { name: 'Filters' });
    const user = userEvent.setup();
    await user.click(box());
    expect(await screen.findByText('Search timed out after 5 s')).toBeDefined();
    expect(screen.getByRole('searchbox', { name: 'Search text' })).toBeDefined();
    expect(box()).toHaveProperty('checked', true);
    expect(panel().getByText('5 entities · 7 supporting relationships')).toBeDefined();
    await user.click(within(main()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(kit.searches).toHaveLength(3));
    expect(kit.searches[2]).toEqual(kit.searches[1]);
  });
});

describe('a facet failure beside groups that answered', () => {
  it('keeps the rows of the groups and puts no failure line among them: the panel says the counts were not read', async () => {
    const kit = searchKit(['demo'], async () => ({ ok: true, value: answerOf('demo', [hit('demo', 'AC-1')], { facets: FAILED_FACETS, failures: [FACETS_FAILURE] }) }), { types: TYPES });
    renderApp(searchAt('demo', 'AC'), kit.client);
    await within(main()).findByRole('heading', { level: 2, name: 'Exact ID match (1)' });
    expect(within(main()).queryByRole('alert')).toBeNull();
    expect(panel().getByText('Filters unavailable: counts not read')).toBeDefined();
  });
});
