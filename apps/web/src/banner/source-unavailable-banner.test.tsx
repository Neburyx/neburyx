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

const timedOutRepeatedly = (retryAfterMs: number | string | undefined, traceId = 'tr-unavailable'): ApiFailure =>
  ({ code: 'SOURCE_UNAVAILABLE', message: 'The source has timed out repeatedly and is being left to recover. Try again shortly.', retryable: true, traceId, details: { reason: 'repeated-timeouts', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } }) as ApiFailure;
const unreachable: ApiFailure = { code: 'SOURCE_UNAVAILABLE', message: 'The source did not answer. Try again shortly.', retryable: true, traceId: 'tr-down', details: { reason: 'unreachable' } };
const refused: ApiFailure = { code: 'SOURCE_UNAVAILABLE', message: 'The source refused the login. Ask an administrator.', retryable: false, traceId: 'tr-auth', details: { reason: 'authentication' } };

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
const fail = async (parts: ReturnType<typeof rig>, failure: ApiFailure, index = 0) => {
  act(() => void parts.expand.expand(ref('a', 'type-a', 'n1'), ['type-a']));
  await act(async () => parts.expansions[index]?.answer({ ok: false, failure }));
};

describe('the Source unavailable banner for repeated timeouts', () => {
  it('shows the state of the ui-spec with the server wait counting down, and keeps the graph and filters as they were', async () => {
    const parts = rig();
    const before = snapshot(parts.state);
    await fail(parts, timedOutRepeatedly(3000));
    const shown = region();
    expect(within(shown).getByText('Repeated timeouts')).toBeTruthy();
    expect(within(shown).getByText('Demo source unavailable after repeated timeouts. The loaded graph remains available.')).toBeTruthy();
    expect(within(shown).getByText('Filters and saved view preserved; retry does not discard the graph.')).toBeTruthy();
    expect(within(shown).getByText('Retry after 3 s')).toBeTruthy();
    expect((within(shown).getByRole('button', { name: 'Retry in 3 s' }) as HTMLButtonElement).disabled).toBe(true);
    expect(shown.className).toContain('status-banner--danger');
    expect(snapshot(parts.state)).toBe(before);
    const polite = () => document.querySelector('[aria-live="assertive"]')?.textContent;
    const announced = polite();
    advance(1000);
    expect(within(region()).getByText('Retry after 2 s')).toBeTruthy();
    expect(polite()).toBe(announced);
    advance(2000);
    expect((within(region()).getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false);
    expect(polite()).not.toBe(announced);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends the same expansion again on Retry after the wait, and the banner clears when it answers', async () => {
    const parts = rig();
    await fail(parts, timedOutRepeatedly(2000));
    advance(2000);
    await userEvent.setup({ advanceTimers: (ms) => void vi.advanceTimersByTime(ms) }).click(screen.getByRole('button', { name: 'Retry' }));
    expect(parts.expansions).toHaveLength(2);
    expect(parts.expansions[1]?.body).toEqual(parts.expansions[0]?.body);
    await act(async () => parts.expansions[1]?.answer({ ok: true, value: page('n9') }));
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
  });

  it('shows the new wait when the breaker answers the retry again', async () => {
    const parts = rig();
    await fail(parts, timedOutRepeatedly(1000));
    advance(1000);
    await userEvent.setup({ advanceTimers: (ms) => void vi.advanceTimersByTime(ms) }).click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => parts.expansions[1]?.answer({ ok: false, failure: timedOutRepeatedly(9000, 'tr-again') }));
    expect(within(region()).getByText('Retry after 9 s')).toBeTruthy();
  });

  it.each([undefined, 0, -5, 1.5, '3000'])('shows no countdown and no number, and an enabled Retry, when the wait is %s', async (wait) => {
    const parts = rig();
    await fail(parts, timedOutRepeatedly(wait));
    const shown = region();
    expect(within(shown).getByText('Demo source unavailable after repeated timeouts. The loaded graph remains available.')).toBeTruthy();
    expect(within(shown).getByText('0 new data retrieved')).toBeTruthy();
    expect(shown.textContent).not.toMatch(/\d+ s/);
    expect((within(shown).getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cannot be retried by mouse before the wait is over', async () => {
    const parts = rig();
    await fail(parts, timedOutRepeatedly(5000));
    await userEvent.setup({ advanceTimers: (ms) => void vi.advanceTimersByTime(ms) }).click(screen.getByRole('button', { name: 'Retry in 5 s' }));
    expect(parts.expansions).toHaveLength(1);
  });
});

describe('the Source unavailable banner for any other retryable reason', () => {
  it('shows the ui-spec state with an enabled Retry and no countdown', async () => {
    const parts = rig();
    await fail(parts, unreachable);
    const shown = region();
    expect(within(shown).getByText('Demo source unavailable. The loaded graph remains available.')).toBeTruthy();
    expect(within(shown).getByText('0 new data retrieved')).toBeTruthy();
    expect((within(shown).getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('builds no banner for a reason that cannot be retried', async () => {
    const parts = rig();
    await fail(parts, refused);
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    expect(parts.banner.showFailure(refused, { source: 'Demo source', resend: () => undefined })).toBe(false);
  });

  it('builds no banner for a retryable index that is not ready, and shows the failure as before', async () => {
    const parts = rig();
    const building: ApiFailure = { code: 'SOURCE_UNAVAILABLE', message: 'A needed index is still building, so the read is slow. Try again later.', retryable: true, traceId: 'tr-i', details: { reason: 'index-building' } };
    await fail(parts, building);
    expect(screen.queryByRole('region', { name: 'Request status' })).toBeNull();
    expect(parts.banner.showFailure(building, { source: 'Demo source', resend: () => undefined })).toBe(false);
  });

  it('leaves the Busy and Timed out banners as they were', async () => {
    const parts = rig();
    await fail(parts, { code: 'SOURCE_BUSY', message: 'The data source is busy. Try again shortly.', retryable: true, traceId: 'tr-b' });
    expect(within(region()).getByText('Busy')).toBeTruthy();
    await fail(parts, { code: 'QUERY_TIMEOUT', message: 'The source did not answer in time. Try again or refine your filters.', retryable: true, traceId: 'tr-t', details: { timeoutMs: 5000 } }, 1);
    expect(within(region()).getByText('Timed out')).toBeTruthy();
    expect(screen.queryByText('Repeated timeouts')).toBeNull();
  });
});
