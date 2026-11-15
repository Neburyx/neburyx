import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PathsRequest, PathsResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { createBuiltInBannerController } from '../banner/built-in-causes.js';
import { createRequestTracker, RUNNING_DELAY_MS } from '../banner/request-tracker.js';
import { okPaths } from './paths-kit.js';
import { createPathsRunStore } from './paths-run-store.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const ASK: PathsRequest = { sourceId: 'a', from: { entityType: 'kind-a', stableId: 'acc-1' }, to: { entityType: 'kind-a', stableId: 'acc-2' }, relTypes: ['link-a'], maxHops: 3, limit: 5 };
const aborted: ApiResult<never> = { ok: false, failure: { code: 'ABORTED' } };

interface Asked {
  readonly request: PathsRequest;
  readonly signal: AbortSignal | undefined;
  answer(result: ApiResult<PathsResponse>): void;
}

function rig() {
  const asked: Asked[] = [];
  const banner = createBuiltInBannerController();
  const tracker = createRequestTracker(banner, { titleOf: () => undefined, timeoutOf: () => 5000 });
  const client = fakeClient({
    findPaths: (request, signal) =>
      new Promise((resolve) => {
        asked.push({ request, signal, answer: resolve });
        signal?.addEventListener('abort', () => resolve(aborted), { once: true });
      }),
  });
  const store = createPathsRunStore(client, 'a', { tracker, banner });
  return { asked, banner, store };
}

const flush = async (): Promise<void> => void (await vi.advanceTimersByTimeAsync(0));
const shown = (banner: ReturnType<typeof createBuiltInBannerController>) => banner.view.getState().banner;

describe('a path search on the banner', () => {
  it('shows nothing for a search that answers at once, and Running after the delay with the elapsed time, the hops and Cancel', async () => {
    const { asked, banner, store } = rig();
    store.run(ASK);
    asked[0]?.answer({ ok: true, value: okPaths([['acc-1', 'acc-2']]) });
    await flush();
    await vi.advanceTimersByTimeAsync(RUNNING_DELAY_MS);
    expect(shown(banner)).toBeUndefined();
    store.run(ASK);
    await vi.advanceTimersByTimeAsync(RUNNING_DELAY_MS);
    expect(shown(banner)).toMatchObject({ id: 'running', headline: 'Finding shortest paths · 1.0 s / 5 s timeout', text: 'Maximum 3 hops; loaded graph and filters preserved.', actions: [{ label: 'Cancel' }] });
  });

  it('shows Cancelled with the side label and Run again when the banner Cancel is used, keeps the previous result and drops the answer', async () => {
    const { asked, banner, store } = rig();
    store.run(ASK);
    asked[0]?.answer({ ok: true, value: okPaths([['acc-1', 'acc-2']]) });
    await flush();
    store.run(ASK);
    await vi.advanceTimersByTimeAsync(RUNNING_DELAY_MS);
    shown(banner)?.actions?.find((action) => action.id === 'cancel')?.run();
    expect(asked[1]?.signal?.aborted).toBe(true);
    expect(shown(banner)).toMatchObject({ id: 'cancelled', headline: 'Cancelled. No new paths added.', sideLabel: '0 new paths added', actions: [{ label: 'Run again' }] });
    asked[1]?.answer({ ok: true, value: okPaths([['acc-1', 'z', 'acc-2']]) });
    await flush();
    const view = store.getState();
    expect(view).toMatchObject({ running: false, cancelled: true });
    expect(view.result?.status === 'ok' && view.result.paths[0]?.hops).toBe(1);
    shown(banner)?.actions?.find((action) => action.id === 'run-again')?.run();
    expect(asked).toHaveLength(3);
    expect(store.getState().cancelled).toBe(false);
  });

  it('shows the same Cancelled state when the search is cancelled from the panel, and takes the Running state away', async () => {
    const { banner, store } = rig();
    store.run(ASK);
    await vi.advanceTimersByTimeAsync(RUNNING_DELAY_MS);
    expect(shown(banner)?.id).toBe('running');
    store.cancel();
    expect(shown(banner)).toMatchObject({ id: 'cancelled', headline: 'Cancelled. No new paths added.' });
    expect(store.getState()).toMatchObject({ running: false, cancelled: true });
  });

  it('aborts the older search when a newer one starts, never shows its answer and leaves one Running state', async () => {
    const { asked, banner, store } = rig();
    store.run(ASK);
    store.run({ ...ASK, maxHops: 2 });
    expect(asked[0]?.signal?.aborted).toBe(true);
    asked[1]?.answer({ ok: true, value: okPaths([['acc-1', 'acc-2']]) });
    await flush();
    asked[0]?.answer({ ok: true, value: okPaths([['acc-1', 'z', 'acc-2']]) });
    await flush();
    expect(store.getState().result?.status === 'ok' && store.getState().result?.paths[0]?.hops).toBe(1);
    await vi.advanceTimersByTimeAsync(RUNNING_DELAY_MS);
    expect(shown(banner)).toBeUndefined();
  });

  it('takes the Running state away when the store is disposed', async () => {
    const { banner, store } = rig();
    store.run(ASK);
    await vi.advanceTimersByTimeAsync(RUNNING_DELAY_MS);
    store.dispose();
    expect(shown(banner)).toBeUndefined();
  });
});
