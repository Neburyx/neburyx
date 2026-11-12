import { act, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVESTIGATION_A, investigationOf, knowing, nodeOf } from '../investigations/test-data.js';
import { answerOf, hit } from '../search/search-test-kit.js';
import { createClientState } from '../state/client-state.js';
import { me, renderApp, source } from '../test-utils.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1'), node: nodeOf('source-a', 'kind-a', 'A-1') };
const searching = (overrides = {}) =>
  knowing([A], { searchEntities: async (request) => ({ ok: true, value: answerOf(request.sourceId, [hit(request.sourceId, request.text)]) }), ...overrides });
const oneSource = { getSources: async () => ({ ok: true as const, value: { items: [source('source-a')], nextCursor: null } }) };

const form = (): HTMLElement => screen.getByRole('search');
function boxOf(): HTMLInputElement {
  const found = within(form()).getByRole('searchbox', { name: 'Search text' });
  if (!(found instanceof HTMLInputElement)) throw new Error('the search box is not an input');
  return found;
}

async function selectorOf(): Promise<HTMLSelectElement> {
  const found = await screen.findByRole('combobox', { name: 'Source' });
  if (!(found instanceof HTMLSelectElement)) throw new Error('the source selector is not a select');
  return found;
}
const press = (target: Element | Document, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => void target.dispatchEvent(event));
  return event;
};

describe('the Home search box', () => {
  it('has the placeholder, the caption of the chosen source and the hint of the registered search key', async () => {
    const view = renderApp('/', searching().client);
    await screen.findByRole('search');
    expect(boxOf().placeholder).toBe('Search an entity or ID');
    expect(screen.getByText('Searches only configured, indexed properties in Source source-a.')).toBeTruthy();
    const bound = view.keyBindings.view.getState().find((binding) => binding.id === 'search');
    await waitFor(() => expect(form().querySelector('kbd')?.textContent).toBe(bound?.shown[0]));
    expect(bound?.shown[0]).toBeTruthy();
  });

  it('shows a selector with two or more sources, defaulting to the source of the last investigation opened, else the first by name, and none with one source', async () => {
    const first = renderApp('/', searching().client);
    expect((await selectorOf()).value).toBe('source-a');
    first.unmount();
    const state = createClientState();
    state.bindSource('source-b');
    const second = renderApp('/', searching().client, state);
    expect((await selectorOf()).value).toBe('source-b');
    expect(screen.getByText('Searches only configured, indexed properties in Source source-b.')).toBeTruthy();
    second.unmount();
    renderApp('/', searching(oneSource).client);
    await screen.findByRole('search');
    expect(screen.queryByRole('combobox', { name: 'Source' })).toBeNull();
  });

  it('says no source is configured, and offers no form, when the list of sources is empty', async () => {
    renderApp('/', searching({ getSources: async () => ({ ok: true, value: { items: [], nextCursor: null } }) }).client);
    expect(await screen.findByText('No source is configured.')).toBeTruthy();
    expect(screen.queryByRole('search')).toBeNull();
  });

  it('takes the text to the Search page for the source chosen here, with the text in the history entry and not in the address, and shows the results', async () => {
    const view = renderApp('/', searching().client);
    const user = userEvent.setup();
    await screen.findByRole('search');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Source' }), 'source-b');
    await user.type(boxOf(), 'AC-1');
    await user.click(within(form()).getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Title AC-1')).toBeTruthy();
    const { pathname, search, state } = view.router.state.location;
    expect(`${pathname}${search}`).toBe('/search?source=source-b');
    expect(state).toEqual({ q: 'AC-1' });
    expect(view.router.state.location.key).not.toBe('default');
    await act(async () => view.router.navigate(-1));
    expect(await screen.findByRole('search')).toBeTruthy();
    expect(view.router.state.location.pathname).toBe('/');
  });

  it('stays on Home for a text of only spaces and sends no search', async () => {
    const sent: string[] = [];
    const kit = searching({ searchEntities: async (request: { readonly sourceId: string; readonly text: string }) => (sent.push(request.text), { ok: true as const, value: answerOf(request.sourceId, [hit(request.sourceId, request.text)]) }) });
    const view = renderApp('/', kit.client);
    const user = userEvent.setup();
    await screen.findByRole('search');
    await user.type(boxOf(), '   ');
    await user.click(within(form()).getByRole('button', { name: 'Search' }));
    expect(screen.getByText('Type an ID or a value to search.')).toBeTruthy();
    expect(view.router.state.location.pathname).toBe('/');
    expect(sent).toEqual([]);
  });

  it('shows the Search page\'s messages beside the box and stays on Home for a text that is too short or too long', async () => {
    const view = renderApp('/', searching().client);
    const user = userEvent.setup();
    await screen.findByRole('search');
    await user.click(within(form()).getByRole('button', { name: 'Search' }));
    expect(screen.getByText('Type an ID or a value to search.')).toBeTruthy();
    await user.type(boxOf(), 'x'.repeat(201));
    await user.click(within(form()).getByRole('button', { name: 'Search' }));
    expect(screen.getByText('Use at most 200 characters.')).toBeTruthy();
    expect(view.router.state.location.pathname).toBe('/');
  });
});

describe('the search key on Home', () => {
  it('opens the Search page with its box focused when the focus is on a control that is not a text field', async () => {
    const view = renderApp('/', searching().client);
    await screen.findByRole('search');
    const button = within(form()).getByRole('button', { name: 'Search' });
    button.focus();
    expect(press(button, 'k', { metaKey: true }).defaultPrevented).toBe(true);
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/search'));
    expect(await screen.findByRole('searchbox', { name: 'Search text' })).toBe(document.activeElement);
  });

  it('is left to the browser while the focus is in the Home box, which keeps its text', async () => {
    const view = renderApp('/', searching().client);
    await screen.findByRole('search');
    await userEvent.setup().type(boxOf(), 'half');
    expect(press(boxOf(), 'k', { metaKey: true }).defaultPrevented).toBe(false);
    expect(boxOf().value).toBe('half');
    expect(view.router.state.location.pathname).toBe('/');
  });
});

describe('the Home search box while the sources and the identity are read', () => {
  it('says it is loading and offers no form while the sources are awaited', async () => {
    renderApp('/', searching({ getSources: () => new Promise(() => undefined) }).client);
    expect(await screen.findAllByText('Loading sources…')).toHaveLength(2);
    expect(screen.queryByRole('search')).toBeNull();
  });

  it('shows the failure with its code and reads the sources again on Try again, which is not the empty list', async () => {
    let reads = 0;
    renderApp('/', searching({ getSources: async () => (++reads === 1 ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : { ok: true, value: { items: [source('source-a')], nextCursor: null } }) }).client);
    expect(await screen.findAllByText('The sources could not be read.')).toHaveLength(2);
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('NETWORK_UNAVAILABLE') === true)).toBe(true);
    expect(screen.queryByText('No source is configured.')).toBeNull();
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Try again' })[0] ?? document.body);
    expect(await screen.findByRole('search')).toBeTruthy();
  });

  it.each([
    ['index-unavailable', 'A needed index is not there, so the read was not run.', false],
    ['index-building', 'A needed index is still building, so the read is slow. Try again later.', true],
  ] as const)('names an unavailable source with the reason %s by its sentence, and offers Try again only when a retry can help', async (reason, message, retryable) => {
    renderApp('/', searching({ getSources: async () => ({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message, retryable, traceId: 'tr-home', details: { reason } } }) }).client);
    const failure = (await screen.findAllByText('The sources could not be read.')).map((paragraph) => paragraph.closest('.search-failure')).find((found) => found !== null);
    if (!(failure instanceof HTMLElement)) throw new Error('the search box shows no failure');
    expect(within(failure).getByRole('alert').textContent).toBe(`${message} · trace tr-home`);
    expect(within(failure).queryByRole('button', { name: 'Try again' }) !== null).toBe(retryable);
  });

  it('shows the failure and reads again when the identity could not be read', async () => {
    let reads = 0;
    renderApp('/', searching({ getMe: async () => (++reads === 1 ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : { ok: true, value: me() }) }).client);
    expect(await screen.findByText('The sources could not be read.')).toBeTruthy();
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Try again' })[0] ?? document.body);
    expect(await screen.findByRole('search')).toBeTruthy();
  });
});
