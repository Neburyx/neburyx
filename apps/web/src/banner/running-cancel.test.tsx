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

const busy: ApiFailure = { code: 'SOURCE_BUSY', message: 'The data source is busy. Try again shortly.', retryable: true, traceId: 'tr-busy' };
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
function rig(timeoutMs: number | null = 5000, delayMs?: number) {
  const expansions: Asked<ExpandRequest, ExpandResponse>[] = [];
  const previews: Asked<DegreePreviewRequest, DegreePreview>[] = [];
  const state = createClientState();
  loadGraph(state, [node('a', 'n1'), node('a', 'n2')], []);
  const banner = createBuiltInBannerController();
  bindBannerToInvestigation(state, banner);
  const asking = <B, T>(list: Asked<B, T>[]) => (body: B, signal?: AbortSignal) =>
    new Promise<ApiResult<T>>((resolve) => {
      list.push({ body, signal, answer: resolve });
      signal?.addEventListener('abort', () => resolve(aborted), { once: true });
    });
  const client = fakeClient({ expandNeighbors: asking(expansions), previewExpansion: asking(previews) });
  const report = bannerReporter(banner, () => 'Demo source');
  const tracker = createRequestTracker(banner, {
    titleOf: (target) => state.loadedGraph().nodes.find((each) => each.ref.stableId === target.stableId)?.display.title,
    timeoutOf: () => timeoutMs ?? undefined,
    ...(delayMs === undefined ? {} : { delayMs }),
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

describe('the Running state of an expansion', () => {
  it('shows nothing before the delay and then the elapsed time against the source timeout, a Cancel, no Dismiss and the side label', async () => {
    const { expand } = rig();
    act(() => void expand.expand(n1, ['type-a']));
    await advance(RUNNING_DELAY_MS - 1);
    expect(noRegion()).toBeNull();
    await advance(1);
    const shown = region();
    expect(within(shown).getByText('Running')).toBeTruthy();
    expect(within(shown).getByText(/^Expanding .+ · 1\.0 s \/ 5 s timeout$/)).toBeTruthy();
    expect(within(shown).getByText('Loaded graph and filters preserved.')).toBeTruthy();
    expect(within(shown).getByText('5 s bounded request')).toBeTruthy();
    expect(within(shown).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(within(shown).queryByRole('button', { name: 'Dismiss' })).toBeNull();
    expect(shown.className).toContain('status-banner--neutral');
  });

  it('shows and announces nothing for a request that answers before the delay', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(n1, ['type-a']));
    await advance(300);
    await act(async () => expansions[0]?.answer({ ok: true, value: page('n9') }));
    await advance(5000);
    expect(noRegion()).toBeNull();
    expect(polite()).toBe('');
  });

  it('is announced once when shown, not at each tick, and the outcome is announced when it replaces it', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(n1, ['type-a']));
    await advance(RUNNING_DELAY_MS);
    const first = polite();
    expect(first).toMatch(/^Running\./);
    await advance(3000);
    expect(polite()).toBe(first);
    await act(async () => expansions[0]?.answer({ ok: false, failure: busy }));
    expect(polite()).toMatch(/^Busy\./);
  });

  it('keeps counting past the source timeout, with the same limit and no other number', async () => {
    const { expand } = rig();
    act(() => void expand.expand(n1, ['type-a']));
    await advance(6400);
    expect(within(region()).getByText(/ · 6\.4 s \/ 5 s timeout$/)).toBeTruthy();
  });

  it('shows the elapsed time alone and no side label when the source timeout is not known', async () => {
    const { expand } = rig(null);
    act(() => void expand.expand(n1, ['type-a']));
    await advance(2000);
    const shown = region();
    expect(within(shown).getByText(/^Expanding .+ · 2\.0 s$/)).toBeTruthy();
    expect(shown.querySelector('.status-banner-side')).toBeNull();
  });

  it('is replaced by the failure of the request, or goes with its answer', async () => {
    const { expand, expansions, state } = rig();
    act(() => void expand.expand(n1, ['type-a']));
    await advance(1500);
    await act(async () => expansions[0]?.answer({ ok: false, failure: busy }));
    expect(within(region()).getByText('Busy')).toBeTruthy();
    act(() => within(region()).getByRole('button', { name: 'Dismiss' }).click());
    act(() => void expand.expand(n2, ['type-a']));
    await advance(1500);
    await act(async () => expansions[1]?.answer({ ok: true, value: page('n9') }));
    expect(noRegion()).toBeNull();
    expect(state.loadedGraph().nodes.map((each) => each.ref.stableId)).toContain('n9');
  });

  it('never replaces the failure banner of another request, and follows the newest request when none is shown', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(n1, ['type-a']));
    act(() => void expand.expand(n2, ['type-a']));
    await advance(RUNNING_DELAY_MS + 100);
    expect(within(region()).getByText(/^Expanding .+ · /)).toBeTruthy();
    await act(async () => expansions[0]?.answer({ ok: false, failure: busy }));
    expect(within(region()).getByText('Busy')).toBeTruthy();
    await advance(3000);
    expect(within(region()).getByText('Busy')).toBeTruthy();
    expect(within(region()).queryByText('Running')).toBeNull();
  });

  it('gives each request its own signal, and Cancel aborts the newest request only', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(n1, ['type-a']));
    await advance(400);
    act(() => void expand.expand(n2, ['type-a']));
    expect(expansions[0]?.signal).toBeDefined();
    expect(expansions[0]?.signal).not.toBe(expansions[1]?.signal);
    await advance(RUNNING_DELAY_MS);
    act(() => fireEvent.click(within(region()).getByRole('button', { name: 'Cancel' })));
    expect(expansions[0]?.signal?.aborted).toBe(false);
    expect(expansions[1]?.signal?.aborted).toBe(true);
  });
});

describe('the Cancelled state of an expansion', () => {
  it('shows the Cancelled state with its copy and Run again, puts focus on the banner region, and leaves the graph and the node as they were', async () => {
    const { state, expand, expansions } = rig();
    const before = snapshot(state);
    act(() => void expand.expand(n1, ['type-a']));
    await advance(1500);
    const cancel = within(region()).getByRole('button', { name: 'Cancel' });
    cancel.focus();
    act(() => fireEvent.click(cancel));
    expect(expansions[0]?.signal?.aborted).toBe(true);
    const shown = region();
    expect(within(shown).getByText('Cancelled')).toBeTruthy();
    expect(within(shown).getByText('Cancelled. No new relationships added.')).toBeTruthy();
    expect(within(shown).getByText('Loaded graph and filters preserved; no complete-result claim.')).toBeTruthy();
    expect(within(shown).getByText('0 new relationships added')).toBeTruthy();
    expect(within(shown).getByRole('button', { name: 'Run again' })).toBeTruthy();
    expect(document.activeElement).toBe(document.querySelector('.banner-region'));
    await advance(0);
    expect(snapshot(state)).toBe(before);
    expect(expand.of(n1)).toMatchObject({ status: 'idle', failure: undefined });
  });

  it('drops an answer that comes after the cancel', async () => {
    const { state, expand, expansions } = rig();
    const before = snapshot(state);
    act(() => void expand.expand(n1, ['type-a']));
    await advance(1500);
    act(() => fireEvent.click(within(region()).getByRole('button', { name: 'Cancel' })));
    await act(async () => expansions[0]?.answer({ ok: true, value: page('n9') }));
    expect(snapshot(state)).toBe(before);
    expect(expand.of(n1).status).toBe('idle');
  });

  it('sends the same request once on Run again and the banner follows the new request', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(n1, ['type-a']));
    await advance(1500);
    act(() => fireEvent.click(within(region()).getByRole('button', { name: 'Cancel' })));
    act(() => fireEvent.click(within(region()).getByRole('button', { name: 'Run again' })));
    expect(expansions).toHaveLength(2);
    expect(expansions[1]?.body).toEqual(expansions[0]?.body);
    expect(noRegion()).toBeNull();
    await advance(RUNNING_DELAY_MS);
    expect(within(region()).getByText('Running')).toBeTruthy();
  });

  it('keeps the cursor and the loaded count of a load more that was cancelled, and the next Load more continues from them', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(n1, ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: true, value: page('n7', 'v1.cursor') }));
    const held = expand.of(n1).types.get('type-a');
    act(() => void expand.loadMore(n1, 'type-a'));
    await advance(1500);
    expect(within(region()).getByText(/^Loading more relationships/)).toBeTruthy();
    act(() => fireEvent.click(within(region()).getByRole('button', { name: 'Cancel' })));
    expect(expand.of(n1).types.get('type-a')).toEqual(held);
    act(() => void expand.loadMore(n1, 'type-a'));
    expect(expansions[2]?.body.cursors).toEqual({ 'type-a': 'v1.cursor' });
  });

  it.each([
    ['a first page', async (rigged: ReturnType<typeof rig>) => void rigged.expand.expand(n1, ['type-a'])],
    ['a multi-type expansion', async (rigged: ReturnType<typeof rig>) => void rigged.expand.load(n1, { first: ['type-a', 'type-b'], more: [], relTypes: undefined })],
    ['a start over', async (rigged: ReturnType<typeof rig>) => void rigged.expand.startOver(n1, 'type-a')],
  ])('leaves the draft, the loaded graph, the selection and the filters as they were when %s is cancelled', async (_name, start) => {
    const rigged = rig();
    const before = snapshot(rigged.state);
    act(() => void start(rigged));
    await advance(1500);
    act(() => fireEvent.click(within(region()).getByRole('button', { name: 'Cancel' })));
    await act(async () => rigged.expansions[0]?.answer({ ok: true, value: page('n9') }));
    expect(snapshot(rigged.state)).toBe(before);
  });

  it('aborts a request that a newer ask for the same node replaces, with no Cancelled banner and only the newer answer merged', async () => {
    const { state, expand, expansions } = rig();
    act(() => void expand.expand(n1, ['type-a']));
    act(() => void expand.expand(n1, ['type-a']));
    expect(expansions[0]?.signal?.aborted).toBe(true);
    expect(expansions[1]?.signal?.aborted).toBe(false);
    await advance(1500);
    expect(within(region()).queryByText('Cancelled')).toBeNull();
    await act(async () => expansions[1]?.answer({ ok: true, value: page('n9') }));
    expect(state.loadedGraph().nodes.map((each) => each.ref.stableId)).toContain('n9');
    expect(noRegion()).toBeNull();
  });
});

describe('the Cancelled state beside another request that is still running', () => {
  it('stays, with Run again, while an older request runs on, and a request begun after the cancel takes its place', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(n1, ['type-a']));
    await advance(400);
    act(() => void expand.expand(n2, ['type-a']));
    await advance(RUNNING_DELAY_MS + 100);
    act(() => fireEvent.click(within(region()).getByRole('button', { name: 'Cancel' })));
    expect(expansions[1]?.signal?.aborted).toBe(true);
    await advance(1000);
    expect(within(region()).getByText('Cancelled')).toBeTruthy();
    expect(within(region()).getByRole('button', { name: 'Run again' })).toBeTruthy();
    act(() => void expand.expand(n2, ['type-a']));
    await advance(RUNNING_DELAY_MS + 300);
    expect(within(region()).getByText('Running')).toBeTruthy();
  });
});

describe('the Running and Cancelled states of a degree preview', () => {
  it('shows Running, and after Cancel the preview copy with Run again, which asks again', async () => {
    const { preview, previews } = rig();
    const request = preview.forNode(n1, false);
    await advance(1500);
    expect(within(region()).getByText(/^Counting relationships/)).toBeTruthy();
    act(() => fireEvent.click(within(region()).getByRole('button', { name: 'Cancel' })));
    expect(previews[0]?.signal?.aborted).toBe(true);
    const shown = region();
    expect(within(shown).getByText('Cancelled. Nothing was added to the graph.')).toBeTruthy();
    expect(within(shown).getByText('Nothing added')).toBeTruthy();
    expect(request.getState().phase).toBe('idle');
    act(() => fireEvent.click(within(shown).getByRole('button', { name: 'Run again' })));
    expect(previews).toHaveLength(2);
  });
});

describe('Cancel by the keyboard', () => {
  it('is reached by Tab and activated by Enter and by Space, and the focus lands on the banner region', async () => {
    vi.useRealTimers();
    for (const key of ['{Enter}', ' ']) {
      const { expand, expansions } = rig(5000, 10);
      act(() => void expand.expand(n1, ['type-a']));
      await screen.findByRole('button', { name: 'Cancel' });
      const user = userEvent.setup();
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
      await user.keyboard(key);
      expect(expansions[0]?.signal?.aborted).toBe(true);
      expect(within(region()).getByText('Cancelled')).toBeTruthy();
      expect(document.activeElement).toBe(document.querySelector('.banner-region'));
      cleanup();
    }
  });
});
