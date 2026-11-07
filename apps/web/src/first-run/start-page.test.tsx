import { act, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InvestigationListResponse, OpenInvestigationRequest, SourceSummary } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult } from '../api/client.js';
import { entityIdOf, INVESTIGATION_A, investigationOf, knowing, listItemOf, listOf, nodeOf, openedOf, type KnownInvestigation } from '../investigations/test-data.js';
import { LINK_NOT_FOUND_TITLE } from '../investigations/messages.js';
import { renderApp, source } from '../test-utils.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const PRESET = { entityType: 'kind-a', stableId: 'A-1', caseRef: 'CASE-1' } as const;
const A: KnownInvestigation = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const demoSource = (overrides: Partial<SourceSummary> = {}): SourceSummary => source('source-a', { synthetic: true, demoCase: PRESET, ...overrides });
const down = { ok: false as const, failure: { code: 'NETWORK_UNAVAILABLE' as const } };

/** An install with nothing opened yet: opening the demo case creates its investigation, which the list then holds. */
function install(sources: readonly SourceSummary[], overrides: Partial<ApiClient> = {}) {
  const known: KnownInvestigation[] = [];
  const sent: OpenInvestigationRequest[] = [];
  const lists: number[] = [];
  const parts = knowing(known, {
    getSources: async () => ({ ok: true, value: { items: [...sources], nextCursor: null } }),
    listInvestigations: async (limit) => {
      lists.push(limit);
      return { ok: true, value: listOf(known.slice(0, limit).map((entry) => listItemOf(entry.investigation)), known.length > limit, known.map((entry) => listItemOf(entry.investigation))) };
    },
    openInvestigation: async (request) => {
      sent.push(request);
      if (!known.includes(A)) known.push(A);
      return { ok: true, value: openedOf(A.investigation, A.node, true) };
    },
    ...overrides,
  });
  return { client: parts.client, known, sent, lists };
}

const firstRun = (): HTMLElement | null => document.querySelector('.first-run');

describe('the start address with no investigation', () => {
  it.each([
    ['no source at all', []],
    ['a synthetic source with no demo case', [source('source-a', { synthetic: true })]],
    ['a synthetic source with a demo case, in the state a fresh install has', [demoSource({ state: 'unknown' })]],
    ['a real source that is unavailable', [source('source-a', { synthetic: false, state: 'unavailable', stateReason: 'Connection refused' })]],
    ['a real source that has not been tested', [source('source-a', { synthetic: false, state: 'unknown' })]],
  ])('shows First run, and none of Home, for %s', async (_name, sources) => {
    renderApp('/', install(sources).client);
    expect(await screen.findByRole('heading', { name: 'No investigations yet', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Investigations', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Recent' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Source health' })).toBeNull();
  });

  it.each(['connected', 'degraded'] as const)('shows Home for a real source that is %s', async (state) => {
    renderApp('/', install([demoSource(), source('source-b', { synthetic: false, state })]).client);
    expect(await screen.findByRole('heading', { name: 'Recent', level: 2 })).toBeTruthy();
    expect(screen.getByRole('searchbox')).toBeTruthy();
    expect(firstRun()).toBeNull();
  });
});

describe('the start address with an investigation', () => {
  it.each([
    ['no source', []],
    ['only a synthetic source', [demoSource()]],
    ['a real source that is unavailable', [source('source-a', { synthetic: false, state: 'unavailable', stateReason: 'Connection refused' })]],
  ])('shows Home for %s, never says that no source is connected, and shows an unavailable source Unavailable', async (_name, sources) => {
    const parts = install(sources);
    parts.known.push(A);
    renderApp('/', parts.client);
    expect(await screen.findByRole('link', { name: 'kind-a A-1' })).toBeTruthy();
    expect(firstRun()).toBeNull();
    expect(within(screen.getByRole('main')).queryByText(/No source connected/i)).toBeNull();
    const unavailable = sources.find((candidate) => candidate.state === 'unavailable');
    if (unavailable !== undefined) {
      const card = await screen.findByRole('region', { name: 'Source health' });
      expect(within(card).getByText('Connection refused')).toBeTruthy();
      expect(document.querySelector('.recent-row')?.textContent).toContain('Source unavailable');
    }
  });
});

describe('opening the demo case from First run', () => {
  it.each([
    ['a click', async (user: ReturnType<typeof userEvent.setup>, button: HTMLElement) => user.click(button)],
    ['Enter', async (user: ReturnType<typeof userEvent.setup>, button: HTMLElement) => (button.focus(), user.keyboard('{Enter}'))],
    ['Space', async (user: ReturnType<typeof userEvent.setup>, button: HTMLElement) => (button.focus(), user.keyboard(' '))],
  ])('sends the one open a deep link to the preset makes, with its case reference, on %s, and shows the investigation in Explore', async (_name, activate) => {
    const parts = install([demoSource({ state: 'unknown' })]);
    const view = renderApp('/', parts.client);
    await activate(userEvent.setup(), await screen.findByRole('button', { name: 'Open demo case' }));
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(parts.sent).toEqual([{ sourceId: 'source-a', entity: { sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' }, caseRef: 'CASE-1', mask: false }]);
    expect(screen.getByText('CASE-1')).toBeTruthy();
    expect(view.router.state.location.pathname).toBe(`/explore/${INVESTIGATION_A}`);
  });

  it('opens the preset of the source whose button is activated, with that source\'s entity type, ID and case reference, when several sources offer one', async () => {
    const parts = install([demoSource({ alias: 'Alpha' }), source('source-b', { alias: 'Beta', synthetic: true, demoCase: { entityType: 'kind-b', stableId: 'K-7', caseRef: 'CASE-7' } })]);
    const view = renderApp('/', parts.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Open demo case · Beta' }));
    await waitFor(() => expect(parts.sent).toHaveLength(1));
    expect(parts.sent[0]).toMatchObject({ sourceId: 'source-b', entity: { sourceId: 'source-b', entityType: 'kind-b', stableId: 'K-7' }, caseRef: 'CASE-7' });
    await act(async () => view.router.navigate('/'));
    await user.click(await screen.findByRole('button', { name: 'Open the demo case · Alpha' }));
    await waitFor(() => expect(parts.sent).toHaveLength(2));
    expect(parts.sent[1]).toMatchObject({ sourceId: 'source-a', entity: { sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' }, caseRef: 'CASE-1' });
  });

  it('opens an entity whose ID is made only of dots', async () => {
    const parts = install([demoSource({ demoCase: { ...PRESET, stableId: '..' } })]);
    renderApp('/', parts.client);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Open demo case' }));
    await waitFor(() => expect(parts.sent).toHaveLength(1));
    expect(parts.sent[0] === undefined ? undefined : entityIdOf(parts.sent[0].entity)).toBe('..');
  });

  it('shows the message of a deep link that finds nothing, with a way back to Home, when the open fails', async () => {
    const parts = install([demoSource()], { openInvestigation: async () => ({ ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-1' } }) });
    renderApp('/', parts.client);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Open demo case' }));
    expect(await screen.findByRole('heading', { name: LINK_NOT_FOUND_TITLE, level: 1 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Home' })).toBeTruthy();
  });

  it('shows Home with the investigation when the person goes back, and First run is not on screen at any moment of that visit', async () => {
    const parts = install([demoSource()]);
    const view = renderApp('/', parts.client);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Open demo case' }));
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    let seen = false;
    const watcher = new MutationObserver(() => {
      if (firstRun() !== null) seen = true;
    });
    watcher.observe(document.body, { childList: true, subtree: true });
    await act(async () => view.router.navigate(-1));
    expect(await screen.findByRole('link', { name: 'kind-a A-1' })).toBeTruthy();
    watcher.disconnect();
    expect(seen).toBe(false);
    expect(firstRun()).toBeNull();
  });
});

describe('the reads that decide the start address', () => {
  it('shows a loading status and neither page while the sources or the list have not answered, and a held count of 0 read again', async () => {
    const waiting = install([demoSource()], { getSources: () => new Promise(() => undefined) });
    const first = renderApp('/', waiting.client);
    expect((await within(screen.getByRole('main')).findByRole('status')).textContent).toBe('Loading…');
    expect(firstRun()).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Recent' })).toBeNull();
    first.unmount();

    let reads = 0;
    const parts = install([demoSource()], { listInvestigations: async () => (++reads === 1 ? { ok: true, value: listOf([]) } : new Promise<never>(() => undefined)) });
    const second = renderApp('/', parts.client);
    await screen.findByRole('heading', { name: 'No investigations yet', level: 2 });
    await userEvent.setup().click(screen.getByRole('link', { name: 'Sources' }));
    await screen.findByRole('heading', { name: 'Sources', level: 1 });
    await act(async () => second.router.navigate('/'));
    expect((await within(screen.getByRole('main')).findByRole('status')).textContent).toBe('Loading…');
    expect(firstRun()).toBeNull();
  });

  it('shows Home with its own failure notice and Try again when the list read failed, keeps it while the retry is under way, and then shows what the retry decides', async () => {
    let reads = 0;
    let release: () => void = () => undefined;
    const retry = new Promise<void>((resolve) => (release = resolve));
    const parts = install([demoSource()], {
      listInvestigations: async () => {
        reads += 1;
        if (reads === 1) return down;
        await retry;
        return { ok: true, value: listOf([]) };
      },
    });
    renderApp('/', parts.client);
    expect((await screen.findByRole('alert')).textContent).toContain('NETWORK_UNAVAILABLE');
    expect(screen.getByRole('heading', { name: 'Recent', level: 2 })).toBeTruthy();
    expect(firstRun()).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Loading recent investigations…')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recent', level: 2 })).toBeTruthy();
    await act(async () => release());
    expect(await screen.findByRole('heading', { name: 'No investigations yet', level: 2 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Recent' })).toBeNull();
  });

  it('keeps Home when the retry of a failed list read fails again', async () => {
    const parts = install([demoSource()], { listInvestigations: async () => down });
    renderApp('/', parts.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.getByRole('heading', { name: 'Recent', level: 2 })).toBeTruthy();
    expect(firstRun()).toBeNull();
  });

  it('shows Home when the sources read failed, keeps it while the retry is under way and replaces it only when the retry succeeds with an answer that chooses First run', async () => {
    let reads = 0;
    let release: () => void = () => undefined;
    const retry = new Promise<void>((resolve) => (release = resolve));
    const parts = install([], {
      getSources: async () => {
        reads += 1;
        if (reads === 1) return down;
        await retry;
        return { ok: true, value: { items: [demoSource()], nextCursor: null } };
      },
    });
    renderApp('/', parts.client);
    const region = await screen.findByRole('region', { name: 'Source health' });
    expect(within(region).getByRole('alert').textContent).toContain('NETWORK_UNAVAILABLE');
    expect(firstRun()).toBeNull();
    await userEvent.setup().click(within(region).getByRole('button', { name: 'Try again' }));
    expect(await within(await screen.findByRole('region', { name: 'Source health' })).findByRole('status')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recent', level: 2 })).toBeTruthy();
    await act(async () => release());
    expect(await screen.findByRole('heading', { name: 'No investigations yet', level: 2 })).toBeTruthy();
  });

  it('keeps Home when the retry of a failed sources read fails again', async () => {
    const parts = install([], { getSources: async () => down });
    renderApp('/', parts.client);
    const user = userEvent.setup();
    await user.click(within(await screen.findByRole('region', { name: 'Source health' })).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Source health' })).queryByRole('status')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Recent', level: 2 })).toBeTruthy();
    expect(firstRun()).toBeNull();
  });

  it('does not let the late answer of an earlier visit decide a later visit', async () => {
    const parts = install([demoSource()]);
    const normal = parts.client.listInvestigations;
    let release: (answer: ApiResult<InvestigationListResponse>) => void = () => undefined;
    let calls = 0;
    const client: ApiClient = { ...parts.client, listInvestigations: (limit, signal) => (++calls === 1 ? new Promise((resolve) => (release = resolve)) : normal(limit, signal)) };
    const view = renderApp('/', client);
    await waitFor(() => expect(calls).toBe(1));
    await act(async () => view.router.navigate('/sources'));
    parts.known.push(A);
    await act(async () => view.router.navigate('/'));
    await waitFor(() => expect(calls).toBe(2));
    let seen = false;
    const watcher = new MutationObserver(() => {
      if (firstRun() !== null) seen = true;
    });
    watcher.observe(document.body, { childList: true, subtree: true });
    await act(async () => release({ ok: true, value: listOf([]) }));
    expect(await screen.findByRole('link', { name: 'kind-a A-1' })).toBeTruthy();
    watcher.disconnect();
    expect(seen).toBe(false);
    expect(firstRun()).toBeNull();
  });

  it('asks for the list once for one visit and once more for each later visit', async () => {
    const parts = install([source('source-a', { synthetic: false })]);
    parts.known.push(A);
    const view = renderApp('/', parts.client);
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(parts.lists).toEqual([5]);
    await userEvent.setup().click(screen.getByRole('link', { name: 'Sources' }));
    await screen.findByRole('heading', { name: 'Sources', level: 1 });
    await act(async () => view.router.navigate('/'));
    await screen.findByRole('link', { name: 'kind-a A-1' });
    expect(parts.lists).toEqual([5, 5]);
  });
});
