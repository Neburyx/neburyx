import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { createClientState } from '../state/client-state.js';
import { renderApp } from '../test-utils.js';
import { answerOf, deferred, hit, searchKit, searchAt } from './search-test-kit.js';

const main = () => screen.getByRole('main');
const selector = () => within(main()).getByRole('combobox', { name: 'Source' });
const ok = (value: SearchResult): ApiResult<SearchResult> => ({ ok: true, value });
const answerFor = async (request: { readonly sourceId: string }) => ok(answerOf(request.sourceId, [hit(request.sourceId, `ID-${request.sourceId}`)]));

describe('the source selector', () => {
  it('is not shown for one source, and the caption names that source', async () => {
    const kit = searchKit(['demo'], answerFor);
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByText('Title ID-demo');
    expect(within(main()).queryByRole('combobox')).toBeNull();
    expect(within(main()).getByText('Searches only configured, indexed properties in Source demo.')).toBeDefined();
  });

  it('is shown for several sources with the name of each, and holds the source that is searched', async () => {
    const kit = searchKit(['demo', 'other'], answerFor);
    renderApp(searchAt('other', 'AC-1'), kit.client);
    await screen.findByText('Title ID-other');
    expect(within(selector()).getAllByRole('option').map((option) => option.textContent)).toEqual(['Source demo', 'Source other']);
    expect(selector()).toHaveProperty('value', 'other');
  });

  it('holds, without a source in the address, the source of the investigation opened last in the session, and completes the address with it', async () => {
    const kit = searchKit(['demo', 'other', 'third'], answerFor);
    const state = createClientState();
    state.bindSource('other');
    const view = renderApp({ pathname: '/search', search: '', state: { q: 'AC-1' } }, kit.client, state);
    await screen.findByText('Title ID-other');
    expect(selector()).toHaveProperty('value', 'other');
    expect(new URLSearchParams(view.router.state.location.search).get('source')).toBe('other');
    expect(view.router.state.location.search).toBe('?source=other');
    expect(view.router.state.location.state).toMatchObject({ q: 'AC-1' });
    expect(kit.searches).toEqual([{ sourceId: 'other', text: 'AC-1' }]);
  });

  it('holds, with no investigation opened, the first source by name', async () => {
    const kit = searchKit(['b-source', 'a-source'], answerFor);
    const view = renderApp('/search', kit.client);
    expect(await screen.findByRole('combobox', { name: 'Source' })).toHaveProperty('value', 'a-source');
    expect(new URLSearchParams(view.router.state.location.search).get('source')).toBe('a-source');
    expect(kit.searches).toEqual([]);
  });

  it('searches the same text in the new source only when it is changed, clears the earlier results, and names the new source in the caption, the source note and the badge', async () => {
    const second = deferred<ApiResult<SearchResult>>();
    let calls = 0;
    const kit = searchKit(['demo', 'other'], (request) => (calls++ === 0 ? answerFor(request) : second.promise), { synthetic: { demo: false, other: true } });
    const view = renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByText('Title ID-demo');
    expect(within(main()).queryByText('Synthetic data')).toBeNull();
    await userEvent.setup().selectOptions(selector(), 'other');
    await waitFor(() => expect(kit.searches).toHaveLength(2));
    expect(kit.searches[1]).toEqual({ sourceId: 'other', text: 'AC-1' });
    expect(new URLSearchParams(view.router.state.location.search).get('source')).toBe('other');
    expect(screen.queryByText('Title ID-demo')).toBeNull();
    expect(within(main()).getByText('Searches only configured, indexed properties in Source other.')).toBeDefined();
    expect(within(main()).getByText('Source other · read-only')).toBeDefined();
    expect(within(main()).getByText('Synthetic data')).toBeDefined();
    await act(async () => second.settle(ok(answerOf('other', [hit('other', 'ID-other')]))));
    expect(await screen.findByText('Title ID-other')).toBeDefined();
    expect(kit.searches.map((request) => request.sourceId)).toEqual(['demo', 'other']);
  });

  it('keeps the focus on the selector after a change, so a keyboard user does not lose their place', async () => {
    const kit = searchKit(['demo', 'other'], answerFor);
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByText('Title ID-demo');
    await userEvent.setup().selectOptions(selector(), 'other');
    await screen.findByText('Title ID-other');
    expect(document.activeElement).toBe(selector());
  });

  it('changes the source of an address that holds no text, without sending a search', async () => {
    const kit = searchKit(['demo', 'other'], answerFor);
    const view = renderApp(searchAt('demo'), kit.client);
    await userEvent.setup().selectOptions(await screen.findByRole('combobox', { name: 'Source' }), 'other');
    await waitFor(() => expect(new URLSearchParams(view.router.state.location.search).get('source')).toBe('other'));
    expect(view.router.state.location.state).not.toHaveProperty('q');
    expect(kit.searches).toEqual([]);
  });

  it('is reached by keyboard, has an accessible name and announces the source in the caption (the arrow keys of a native select are the browser\'s, checked in the real browser)', async () => {
    const kit = searchKit(['demo', 'other'], answerFor);
    renderApp(searchAt('demo', 'AC-1'), kit.client);
    await screen.findByText('Title ID-demo');
    const user = userEvent.setup();
    await user.click(within(main()).getByRole('searchbox', { name: 'Search text' }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(selector());
    await user.selectOptions(selector(), 'other');
    await screen.findByText('Title ID-other');
    expect(selector()).toHaveProperty('value', 'other');
    expect(within(main()).getByText('Searches only configured, indexed properties in Source other.').getAttribute('aria-live')).toBe('polite');
  });

  it('never searches in two sources: every request names one source, and a link to a source that is not configured searches none', async () => {
    const kit = searchKit(['demo', 'other'], answerFor);
    renderApp(searchAt('missing', 'AC-1'), kit.client);
    expect(await screen.findByText('The source “missing” is not configured.')).toBeDefined();
    expect(within(main()).queryByRole('combobox')).toBeNull();
    expect(kit.searches).toEqual([]);
  });
});
