import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DegreePreview, DegreePreviewRequest, ExpandRequest, ExpandResponse } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(() => cleanup());

const busy = (traceId = 'tr-busy'): ApiFailure => ({ code: 'SOURCE_BUSY', message: 'The data source is busy. Try again shortly.', retryable: true, traceId });
const timedOut: ApiFailure = { code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: 'tr-t', details: { timeoutMs: 5000 } };

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

describe('the Busy banner of an expansion', () => {
  it('shows the Busy state of frame 35, with the display name of the source, and keeps the graph and the node as they were', async () => {
    const { state, expand, expansions } = rig();
    const before = snapshot(state);
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: busy() }));
    const shown = region();
    expect(within(shown).getByText('Busy')).toBeTruthy();
    expect(within(shown).getByText('Demo source is busy. No read slot freed within the wait.')).toBeTruthy();
    expect(within(shown).getByText('Loaded graph and filters preserved; nothing was read. Retry when ready.')).toBeTruthy();
    expect(within(shown).getByText('No read slot freed')).toBeTruthy();
    expect(within(shown).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(shown.className).toContain('status-banner--warning');
    expect(snapshot(state)).toBe(before);
    expect(expand.of(ref('a', 'type-a', 'n1'))).toMatchObject({ status: 'idle', failure: undefined });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('announces it politely, and Tab reaches Retry and then Dismiss', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: busy() }));
    const polite = document.querySelector('[aria-live="polite"]');
    expect(polite?.textContent).toBe('Busy. Demo source is busy. No read slot freed within the wait.. Loaded graph and filters preserved; nothing was read. Retry when ready.');
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retry' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss' }));
  });

  it.each(['click', 'enter', 'space'] as const)('sends the same expansion once on Retry by %s, merges its answer, and shows the banner again on a second Busy', async (how) => {
    const { state, expand, expansions } = rig();
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: busy() }));
    const user = userEvent.setup();
    const retry = screen.getByRole('button', { name: 'Retry' });
    if (how === 'click') await user.click(retry);
    else {
      retry.focus();
      await user.keyboard(how === 'enter' ? '{Enter}' : ' ');
    }
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    expect(expansions).toHaveLength(2);
    expect(expansions[1]?.body).toEqual(expansions[0]?.body);
    await act(async () => expansions[1]?.answer({ ok: true, value: page('n9') }));
    expect(state.loadedGraph().nodes.map((each) => each.ref.stableId)).toContain('n9');
    act(() => void expand.expand(ref('a', 'type-a', 'n2'), ['type-a']));
    await act(async () => expansions[2]?.answer({ ok: false, failure: busy('tr-again') }));
    expect(region()).toBeTruthy();
  });

  it('sends a Load more again with the same cursor', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: true, value: { ...page('n7'), pages: [{ neighborType: 'type-a', returned: 1, hasMore: true, nextCursor: 'v1.cursor', matchingTotal: { quality: 'unknown', scope: 'expand:type-a' } }] } }));
    act(() => void expand.loadMore(ref('a', 'type-a', 'n1'), 'type-a'));
    await act(async () => expansions[1]?.answer({ ok: false, failure: busy() }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(expansions[2]?.body).toEqual(expansions[1]?.body);
    expect(expansions[2]?.body.cursors).toEqual({ 'type-a': 'v1.cursor' });
  });
});

describe('several Busy failures while the banner is shown', () => {
  it('keeps one banner and sends each again once, in the order they failed: two expansions', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    act(() => void expand.expand(ref('a', 'type-a', 'n2'), ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: busy('tr-1') }));
    await act(async () => expansions[1]?.answer({ ok: false, failure: busy('tr-2') }));
    expect(screen.getAllByRole('region', { name: 'Request status' })).toHaveLength(1);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(expansions.slice(2).map((asked) => asked.body.ref.stableId)).toEqual(['n1', 'n2']);
  });

  it('sends an expansion and a preview again, in the order they failed', async () => {
    const { expand, preview, expansions, previews } = rig();
    const request = preview.forNode(ref('a', 'type-a', 'n2'), false);
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    await act(async () => previews[0]?.answer({ ok: false, failure: busy('tr-p') }));
    await act(async () => expansions[0]?.answer({ ok: false, failure: busy('tr-e') }));
    expect(request.getState()).toMatchObject({ phase: 'failed' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(previews).toHaveLength(2);
    expect(expansions).toHaveLength(2);
  });

  it('starts a new list once the banner was dismissed', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: busy('tr-1') }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    act(() => void expand.expand(ref('a', 'type-a', 'n2'), ['type-a']));
    await act(async () => expansions[1]?.answer({ ok: false, failure: busy('tr-2') }));
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(expansions.slice(2).map((asked) => asked.body.ref.stableId)).toEqual(['n2']);
  });
});

describe('the Busy banner of a degree preview', () => {
  it('shows the Busy state, keeps the failure in the store for the submenu, and asks for the preview again on Retry', async () => {
    const { preview, previews } = rig();
    const request = preview.forNode(ref('a', 'type-a', 'n1'), false);
    await act(async () => previews[0]?.answer({ ok: false, failure: busy() }));
    expect(within(region()).getByText('Demo source is busy. No read slot freed within the wait.')).toBeTruthy();
    expect(request.getState()).toMatchObject({ phase: 'failed', failure: { code: 'SOURCE_BUSY' } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(previews).toHaveLength(2);
    expect(previews[1]?.body).toEqual(previews[0]?.body);
  });
});

describe('failures that do not show the Busy banner', () => {
  it('leaves another code to the node, as before', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: timedOut }));
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('QUERY_TIMEOUT · trace tr-t');
  });

  it('leaves a failure the client made itself to the node, as before', async () => {
    const { expand, expansions } = rig();
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    expect(expand.of(ref('a', 'type-a', 'n1'))).toMatchObject({ status: 'failed', failure: { code: 'NETWORK_UNAVAILABLE' } });
  });
});

describe('a change of investigation', () => {
  it('clears the Busy banner and sends nothing', async () => {
    const { state, expand, expansions } = rig();
    act(() => void expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
    await act(async () => expansions[0]?.answer({ ok: false, failure: busy() }));
    act(() => state.bindSource('b'));
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    expect(expansions).toHaveLength(1);
  });
});
