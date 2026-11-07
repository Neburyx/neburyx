import { act, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVESTIGATION_A, investigationOf, knowing, nodeOf } from '../investigations/test-data.js';
import { me, renderApp, source, testReport } from '../test-utils.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1'), node: nodeOf('source-a', 'kind-a', 'A-1') };
const twoSources = { getSources: async () => ({ ok: true as const, value: { items: [source('source-a'), source('source-b')], nextCursor: null } }) };
const down = { ok: false as const, failure: { code: 'NETWORK_UNAVAILABLE' as const } };

describe('the buttons of Home', () => {
  it('marks Search and the Open buttons of the prompt primary and the entry action link-style', async () => {
    renderApp('/', knowing([A], twoSources).client);
    const search = await screen.findByRole('button', { name: 'Search' });
    expect(search.className).toBe('primary');
    const entry = screen.getByRole('button', { name: 'Open a deep link' });
    expect(entry.className).toBe('link');
    await userEvent.setup().click(entry);
    const opens = [screen.getByRole('form', { name: 'Open a link' }), screen.getByRole('form', { name: 'Open by parts' })].map((form) => within(form).getByRole('button', { name: 'Open' }));
    expect(opens.map((button) => button.className)).toEqual(['primary', 'primary']);
  });

  it('marks the Try again of a failed list and of a failed source read secondary', async () => {
    renderApp('/', knowing([A], { ...twoSources, listInvestigations: async () => down }).client);
    expect((await screen.findByRole('button', { name: 'Try again' })).className).toBe('secondary');
    const failed = renderApp('/', knowing([A], { getSources: async () => down }).client);
    const buttons = await screen.findAllByRole('button', { name: 'Try again' });
    expect(buttons.map((button) => button.className)).toContain('secondary');
    failed.unmount();
  });

  it('keeps the tab order: the source selector, the search box, Search, then the entry action', async () => {
    renderApp('/', knowing([A], { ...twoSources, getMe: async () => ({ ok: true as const, value: me() }) }).client);
    const user = userEvent.setup();
    const selector = await screen.findByRole('combobox', { name: 'Source' });
    selector.focus();
    const stops = [selector.getAttribute('aria-label')];
    for (let press = 0; press < 3; press += 1) {
      await user.tab();
      const active = document.activeElement;
      stops.push(active?.getAttribute('aria-label') ?? active?.textContent ?? '');
    }
    expect(stops).toEqual(['Source', 'Search text', 'Search', 'Open a deep link']);
  });
});

describe('the entry action for the demo case on Home', () => {
  const preset = { entityType: 'kind-a', stableId: 'A-1', caseRef: 'CASE-1' };
  const demo = (id: string, overrides = {}) => source(id, { synthetic: true, demoCase: preset, ...overrides });
  const sourcesOf = (...items: ReturnType<typeof source>[]) => ({ getSources: async () => ({ ok: true as const, value: { items, nextCursor: null } }) });
  const entry = () => screen.queryAllByRole('button', { name: /^Open the demo case/ });

  it('sits beside Open a deep link, link-style, after it in the tab order, and opens the preset with its case reference by click, Enter and Space', async () => {
    const sent: unknown[] = [];
    const parts = knowing([A], { ...sourcesOf(demo('source-a', { state: 'unknown' })), openInvestigation: async (request) => (sent.push(request), { ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-1' } }) });
    renderApp('/', parts.client);
    const action = await screen.findByRole('button', { name: 'Open the demo case' });
    expect(action.className).toBe('link');
    const row = action.closest('.entry-actions');
    if (row === null || !(row instanceof HTMLElement)) throw new Error('the action is not in the entry actions');
    const buttons = within(row).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Open a deep link', 'Open the demo case']);
    const user = userEvent.setup();
    await user.click(action);
    await screen.findByRole('heading', { name: 'Nothing was found at this link', level: 1 });
    await user.click(screen.getByRole('link', { name: 'Back to Home' }));
    const again = await screen.findByRole('button', { name: 'Open the demo case' });
    again.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('heading', { name: 'Nothing was found at this link', level: 1 });
    await user.click(screen.getByRole('link', { name: 'Back to Home' }));
    (await screen.findByRole('button', { name: 'Open the demo case' })).focus();
    await user.keyboard(' ');
    await screen.findByRole('heading', { name: 'Nothing was found at this link', level: 1 });
    expect(sent).toEqual(Array(3).fill({ sourceId: 'source-a', entity: { sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' }, caseRef: 'CASE-1', mask: false }));
  });

  it('opens the preset of the source whose action is activated, when several sources offer one', async () => {
    const sent: Array<{ sourceId: string; entity: { entityType: string; stableId?: string; value?: string }; caseRef?: string }> = [];
    const other = { entityType: 'kind-b', stableId: 'K-7', caseRef: 'CASE-7' };
    const parts = knowing([A], { ...sourcesOf(demo('source-a', { alias: 'Alpha' }), demo('source-b', { alias: 'Beta', demoCase: other })), openInvestigation: async (request) => (sent.push(request), { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    const view = renderApp('/', parts.client);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Open the demo case · Beta' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ sourceId: 'source-b', entity: { entityType: 'kind-b', stableId: 'K-7' }, caseRef: 'CASE-7' });
    await act(async () => view.router.navigate('/'));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Open the demo case · Alpha' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ sourceId: 'source-a', entity: { entityType: 'kind-a', stableId: 'A-1' }, caseRef: 'CASE-1' });
  });

  it('puts the source alias after the label for each of several demo sources, whatever its state, and shows none when no source offers one', async () => {
    const several = renderApp('/', knowing([A], sourcesOf(demo('source-a', { alias: 'Alpha' }), demo('source-b', { alias: 'Beta', state: 'unavailable' }), source('source-c', { synthetic: true }))).client);
    await screen.findByRole('button', { name: 'Open the demo case · Alpha' });
    expect(entry().map((button) => button.textContent)).toEqual(['Open the demo case · Alpha', 'Open the demo case · Beta']);
    several.unmount();
    renderApp('/', knowing([A], sourcesOf(source('source-a', { synthetic: true }), source('source-b', { synthetic: false }))).client);
    await screen.findByRole('button', { name: 'Open a deep link' });
    expect(entry()).toHaveLength(0);
  });

  it('shows no demo action while the sources are not answered, and keeps the actions of the answer held when a later read fails', async () => {
    const waiting = renderApp('/', knowing([A], { getSources: () => new Promise(() => undefined) }).client);
    await screen.findByRole('button', { name: 'Open a deep link' });
    expect(entry()).toHaveLength(0);
    waiting.unmount();
    let reads = 0;
    const parts = knowing([A], { getSources: async () => (++reads === 1 ? { ok: true as const, value: { items: [demo('source-a')], nextCursor: null } } : down), testSource: async (id) => ({ ok: true, value: testReport(id) }) });
    renderApp('/sources', parts.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Test source' }));
    await waitFor(() => expect(reads).toBe(2));
    await user.click(screen.getByRole('link', { name: 'Home' }));
    expect(await screen.findByRole('button', { name: 'Open the demo case' })).toBeTruthy();
    expect(within(await screen.findByRole('region', { name: 'Source health' })).getByRole('alert').textContent).toContain('NETWORK_UNAVAILABLE');
  });
});
