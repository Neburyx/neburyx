import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DegreePreview, DegreePreviewRequest, ExpandRequest, ExpandResponse } from '@neburyx/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiFailure, ApiResult } from '../api/client.js';
import { createExpandStore } from '../api/expand-store.js';
import { fakeClient } from '../api/fake-client.js';
import { createPreviewStore } from '../api/preview-store.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { edge, node, ref } from '../state/test-data.js';
import { ExpandProvider } from '../workspace/expand-context.js';
import { ExpansionStatus } from '../workspace/expansion-status.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { BannerProvider } from './banner-context.js';
import { bannerReporter } from './banner-reporter.js';
import { bindBannerToInvestigation } from './bind-investigation.js';
import { createBuiltInBannerController } from './built-in-causes.js';
import { StatusBanner } from './status-banner.js';

beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const limited = (retryAfterMs: number | undefined, traceId = 'tr-rate'): ApiFailure => ({ code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.', retryable: true, traceId, ...(retryAfterMs === undefined ? {} : { details: { retryAfterMs } }) });

const page = (neighbor: string): ExpandResponse => ({
  ref: ref('a', 'type-a', 'n1'),
  pageSize: 25,
  nodes: [node('a', neighbor)],
  edges: [edge('a', `e-${neighbor}`, 'n1', neighbor)],
  pages: [{ neighborType: 'type-a', returned: 1, hasMore: false, matchingTotal: { value: 1, quality: 'exact', scope: 'expand:type-a' } }],
  warnings: [],
});

interface Asked<B, T> {
  readonly body: B;
  answer(result: ApiResult<T>): void;
}

function rig() {
  const expansions: Asked<ExpandRequest, ExpandResponse>[] = [];
  const previews: Asked<DegreePreviewRequest, DegreePreview>[] = [];
  const state = createClientState();
  loadGraph(state, [node('a', 'n1'), node('a', 'n2')], []);
  const banner = createBuiltInBannerController();
  bindBannerToInvestigation(state, banner);
  const client = fakeClient({
    expandNeighbors: (body) => new Promise((resolve) => void expansions.push({ body, answer: resolve })),
    previewExpansion: (body) => new Promise((resolve) => void previews.push({ body, answer: resolve })),
  });
  const report = bannerReporter(banner, (sourceId) => (sourceId === 'a' ? 'Demo source' : sourceId));
  const expand = createExpandStore(client, state, () => 'person-1', report);
  const preview = createPreviewStore(client, () => 'person-1', report);
  render(
    <ClientStateProvider state={state}>
      <BannerProvider controller={banner}>
        <StatusBanner />
        <ExpandProvider store={expand}>
          <ExpansionStatus />
        </ExpandProvider>
      </BannerProvider>
    </ClientStateProvider>,
  );
  return { state, banner, expand, preview, expansions, previews };
}

const region = () => screen.getByRole('region', { name: 'Request status' });
const snapshot = (state: ClientState) => JSON.stringify({ investigation: state.investigation.getState(), presentation: state.presentation.view.getState(), graph: state.loadedGraph() });
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const user = () => userEvent.setup({ advanceTimers: (ms) => void vi.advanceTimersByTime(ms) });

describe('the Rate limited banner', () => {
  it('shows the state of frame 35 with the server wait, and keeps the graph and the node as they were', async () => {
    const { state, expand, expansions } = rig();
    const before = snapshot(state);
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: limited(12_000) }));
    const shown = region();
    expect(within(shown).getByText('Rate limited')).toBeTruthy();
    expect(within(shown).getByText('Too many requests. Retry after 12 s.')).toBeTruthy();
    expect(within(shown).getByText('Loaded graph and filters preserved; nothing was read. The wait is set by the server.')).toBeTruthy();
    expect(within(shown).getByText('Retry after 12 s')).toBeTruthy();
    expect(within(shown).getByRole('button', { name: 'Retry in 12 s' })).toBeTruthy();
    expect(shown.className).toContain('status-banner--warning');
    expect(snapshot(state)).toBe(before);
  });

  it('counts down from the server value and the clock, announces once, and holds Retry until the wait is over', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: limited(3_000) }));
    const polite = () => document.querySelector('[aria-live="polite"]')?.textContent;
    const announced = polite();
    expect(announced).toContain('Too many requests. Retry after 3 s.');
    advance(1_000);
    expect(within(region()).getByText('Too many requests. Retry after 2 s.')).toBeTruthy();
    expect(within(region()).getByText('Retry after 2 s')).toBeTruthy();
    expect((within(region()).getByRole('button', { name: 'Retry in 2 s' }) as HTMLButtonElement).disabled).toBe(true);
    expect(polite()).toBe(announced);
    advance(1_000);
    expect((within(region()).getByRole('button', { name: 'Retry in 1 s' }) as HTMLButtonElement).disabled).toBe(true);
    advance(1_000);
    expect(polite()).toBe('Rate limited. Too many requests. You can retry now. Loaded graph and filters preserved; nothing was read. The wait is set by the server.');
    expect(within(region()).getByText('Too many requests. You can retry now.')).toBeTruthy();
    expect((within(region()).getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cannot be retried by mouse or keyboard before the wait is over, and Tab skips it to Dismiss', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: limited(5_000) }));
    const person = user();
    await person.click(screen.getByRole('button', { name: 'Retry in 5 s' }));
    await person.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss' }));
    expect(expansions).toHaveLength(1);
  });

  it.each(['click', 'enter', 'space'] as const)('sends the same expansion once on Retry by %s after the wait, and the graph is as it was', async (how) => {
    const { state, expand, expansions } = rig();
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: limited(2_000) }));
    advance(2_000);
    const person = user();
    const retry = screen.getByRole('button', { name: 'Retry' });
    if (how === 'click') await person.click(retry);
    else {
      retry.focus();
      await person.keyboard(how === 'enter' ? '{Enter}' : ' ');
    }
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    expect(expansions).toHaveLength(2);
    expect(expansions[1]?.body).toEqual(expansions[0]?.body);
    await act(async () => expansions[1]?.answer({ ok: true, value: page('n9') }));
    expect(state.loadedGraph().nodes.map((each) => each.ref.stableId)).toContain('n9');
  });

  it('counts down the longest wait when a second request is rate limited, and Retry sends both once, in order, when both are over', async () => {
    const { expand, preview, expansions, previews } = rig();
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    preview.forNode(ref('a', 'type-a', 'n2'), false);
    await act(async () => expansions[0]?.answer({ ok: false, failure: limited(4_000, 'tr-1') }));
    advance(1_000);
    await act(async () => previews[0]?.answer({ ok: false, failure: limited(6_000, 'tr-2') }));
    expect(within(region()).getByText('Too many requests. Retry after 6 s.')).toBeTruthy();
    advance(4_000);
    expect((within(region()).getByRole('button', { name: 'Retry in 2 s' }) as HTMLButtonElement).disabled).toBe(true);
    advance(2_000);
    await user().click(screen.getByRole('button', { name: 'Retry' }));
    expect(expansions).toHaveLength(2);
    expect(previews).toHaveLength(2);
  });

  it('stops counting when the banner is dismissed or replaced', async () => {
    const { banner, expand, expansions } = rig();
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: limited(30_000) }));
    expect(vi.getTimerCount()).toBe(1);
    await user().click(screen.getByRole('button', { name: 'Dismiss' }));
    advance(1_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    act(() => void expand.expand(ref('a', 'type-a', 'n2'), ['type-a']));
    await act(async () => expansions[1]?.answer({ ok: false, failure: limited(30_000, 'tr-3') }));
    act(() => banner.show({ id: 'other', tone: 'neutral', chip: 'Other', headline: 'Another state', text: 'Replaced.', actions: [] }));
    advance(1_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(within(region()).getByText('Another state')).toBeTruthy();
  });

  it.each([undefined, 0, -5])('shows no banner for a wait of %s, and leaves the failure to the caller', async (wait) => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: limited(wait) }));
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
