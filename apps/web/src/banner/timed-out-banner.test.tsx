import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
import { createRequestTracker, RUNNING_DELAY_MS } from './request-tracker.js';
import { StatusBanner } from './status-banner.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const timedOut = (timeoutMs: number | null = 5000, traceId = 'tr-t'): ApiFailure => ({ code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId, ...(timeoutMs === null ? {} : { details: { timeoutMs } }) });
const aborted: ApiResult<never> = { ok: false, failure: { code: 'ABORTED' } };

const page = (neighbor: string, cursor?: string): ExpandResponse => ({
  ref: ref('a', 'type-a', 'n1'),
  pageSize: 25,
  nodes: [node('a', neighbor)],
  edges: [edge('a', `e-${neighbor}`, 'n1', neighbor)],
  pages: [{ neighborType: 'type-a', returned: 1, hasMore: cursor !== undefined, ...(cursor === undefined ? {} : { nextCursor: cursor }), matchingTotal: { quality: 'unknown', scope: 'expand:type-a' } }],
  warnings: [],
});

interface Asked<B, T> {
  readonly body: B;
  readonly signal: AbortSignal | undefined;
  answer(result: ApiResult<T>): void;
}

/** A client whose reads end as ABORTED when their signal aborts, as the real one's do. */
function rig(sourceName = 'Demo source', ignoreAbort = false) {
  const expansions: Asked<ExpandRequest, ExpandResponse>[] = [];
  const previews: Asked<DegreePreviewRequest, DegreePreview>[] = [];
  const state = createClientState();
  loadGraph(state, [node('a', 'n1'), node('a', 'n2')], []);
  const banner = createBuiltInBannerController();
  bindBannerToInvestigation(state, banner);
  const asking = <B, T>(list: Asked<B, T>[]) => (body: B, signal?: AbortSignal) =>
    new Promise<ApiResult<T>>((resolve) => {
      list.push({ body, signal, answer: resolve });
      if (!ignoreAbort) signal?.addEventListener('abort', () => resolve(aborted), { once: true });
    });
  const client = fakeClient({ expandNeighbors: asking(expansions), previewExpansion: asking(previews) });
  const report = bannerReporter(banner, () => sourceName);
  const tracker = createRequestTracker(banner, {
    titleOf: (target) => state.loadedGraph().nodes.find((each) => each.ref.stableId === target.stableId)?.display.title,
    timeoutOf: () => 5000,
  });
  const expand = createExpandStore(client, state, () => 'person-1', report, undefined, tracker);
  const preview = createPreviewStore(client, () => 'person-1', report, tracker);
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

const n1 = ref('a', 'type-a', 'n1');
const n2 = ref('a', 'type-a', 'n2');
const region = () => screen.getByRole('region', { name: 'Request status' });
const noRegion = () => screen.queryByRole('region', { name: 'Request status' });
const snapshot = (state: ClientState) => JSON.stringify({ investigation: state.investigation.getState(), presentation: state.presentation.view.getState(), graph: state.loadedGraph() });
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const polite = () => document.querySelector('[aria-live="polite"]')?.textContent;

describe('the Timed out state', () => {
  it('shows the chip, the headline with the source and the limit, the text, the side label and Retry, announced once, and keeps the graph', async () => {
    const { state, expand, expansions } = rig();
    const before = snapshot(state);
    act(() => void expand.expand(n1, ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: timedOut() }));
    const shown = region();
    expect(within(shown).getByText('Timed out')).toBeTruthy();
    expect(within(shown).getByText('Demo source did not answer within 5 s.')).toBeTruthy();
    expect(within(shown).getByText('Loaded graph and filters preserved; nothing was merged. Retry when ready.')).toBeTruthy();
    expect(within(shown).getByText('Nothing merged')).toBeTruthy();
    expect(within(shown).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(shown.className).toContain('status-banner--warning');
    expect(polite()).toBe('Timed out. Demo source did not answer within 5 s. Loaded graph and filters preserved; nothing was merged. Retry when ready.');
    expect(snapshot(state)).toBe(before);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    [1500, '1.5 s'],
    [10_000, '10 s'],
  ])('writes a limit of %i ms as %s', async (limit, written) => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(n1, ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: timedOut(limit) }));
    expect(within(region()).getByText(`Demo source did not answer within ${written}.`)).toBeTruthy();
  });

  it('shows it for a degree preview too, and keeps the failure for the submenu', async () => {
    const { preview, previews } = rig();
    const request = preview.forNode(n1, false);
    await act(async () => previews[0]?.answer({ ok: false, failure: timedOut() }));
    expect(within(region()).getByText('Demo source did not answer within 5 s.')).toBeTruthy();
    expect(request.getState()).toMatchObject({ phase: 'failed', failure: { code: 'QUERY_TIMEOUT' } });
  });

  describe('with real timers, for the keyboard', () => {
    beforeEach(() => vi.useRealTimers());

    it.each(['click', 'enter', 'space'] as const)('sends the same request once on Retry by %s, and not twice on a second press', async (how) => {
      const { expand, expansions } = rig();
      act(() => void expand.expand(n1, ['type-a']));
      await act(async () => expansions[0]?.answer({ ok: false, failure: timedOut() }));
      const user = userEvent.setup();
      const retry = screen.getByRole('button', { name: 'Retry' });
      if (how === 'click') await user.click(retry);
      else {
        retry.focus();
        await user.keyboard(how === 'enter' ? '{Enter}' : ' ');
      }
      if (how === 'click') await user.click(retry);
      expect(noRegion()).toBeNull();
      expect(expansions).toHaveLength(2);
      expect(expansions[1]?.body).toEqual(expansions[0]?.body);
    });

    it('keeps one banner for two timed-out requests, and one Retry sends each once, in the order they failed', async () => {
      const { expand, expansions } = rig();
      act(() => void expand.expand(n1, ['type-a']));
      act(() => void expand.expand(n2, ['type-a']));
      await act(async () => expansions[1]?.answer({ ok: false, failure: timedOut(5000, 'tr-2') }));
      await act(async () => expansions[0]?.answer({ ok: false, failure: timedOut(5000, 'tr-1') }));
      expect(screen.getAllByRole('region', { name: 'Request status' })).toHaveLength(1);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
      expect(expansions.slice(2).map((asked) => asked.body.ref.stableId)).toEqual(['n2', 'n1']);
    });

  });

  it('builds no banner for a failure that names no limit, or when the source has no name, and the node keeps its inline alert', async () => {
    const first = rig();
    act(() => void first.expand.expand(n1, ['type-a']));
    await act(async () => first.expansions[0]?.answer({ ok: false, failure: timedOut(null) }));
    expect(noRegion()).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('QUERY_TIMEOUT · trace tr-t');
    cleanup();
    const second = rig('  ');
    act(() => void second.expand.expand(n1, ['type-a']));
    await act(async () => second.expansions[0]?.answer({ ok: false, failure: timedOut() }));
    expect(noRegion()).toBeNull();
  });

  it('replaces the Running banner of the request that timed out, with no Cancelled banner and no elapsed time', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(n1, ['type-a']));
    await advance(RUNNING_DELAY_MS + 2000);
    expect(within(region()).getByText('Running')).toBeTruthy();
    await act(async () => expansions[0]?.answer({ ok: false, failure: timedOut() }));
    const shown = region();
    expect(within(shown).getByText('Timed out')).toBeTruthy();
    expect(within(shown).queryByText('Running')).toBeNull();
    expect(within(shown).queryByText('Cancelled')).toBeNull();
    expect(shown.textContent).not.toMatch(/ s \/ /);
    await advance(5000);
    expect(within(region()).getByText('Timed out')).toBeTruthy();
  });

  it('shows Cancelled, never Timed out, for a timeout that arrives after the person pressed Cancel', async () => {
    const { expand, expansions } = rig('Demo source', true);
    act(() => void expand.expand(n1, ['type-a']));
    await advance(RUNNING_DELAY_MS);
    act(() => within(region()).getByRole('button', { name: 'Cancel' }).click());
    await act(async () => expansions[0]?.answer({ ok: false, failure: timedOut() }));
    const shown = region();
    expect(within(shown).getByText('Cancelled')).toBeTruthy();
    expect(within(shown).queryByText('Timed out')).toBeNull();
  });
});
