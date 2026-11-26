import type { DegreePreview, ExpandResponse } from '@neburyx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBannerController } from '../banner/banner-controller.js';
import { createClientState } from '../state/client-state.js';
import { node } from '../state/test-data.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import type { ApiResult } from './client.js';
import { createExpandStore } from './expand-store.js';
import { fakeClient } from './fake-client.js';
import { createHeavyGuard } from './heavy-guard.js';
import { createPreviewStore } from './preview-store.js';
import { READ_WAIT_MS } from './read-wait.js';

const ref = (stableId: string, sourceId = 'demo') => ({ sourceId, entityType: 'widget', stableId });
const previewOf = (stableId: string): DegreePreview => ({ ref: ref(stableId), total: { value: 1, quality: 'exact', scope: 'x' }, byType: [], byNeighborType: [], warnings: [], pageSize: 25, heavyOpThreshold: 500 });

interface Pending {
  readonly body: { sourceId: string; ref: { stableId: string }; mask?: boolean };
  readonly answer: (result: ApiResult<DegreePreview>) => void;
}

function rig() {
  const pending: Pending[] = [];
  const client = fakeClient({
    previewExpansion: (body) =>
      new Promise((resolve) => {
        pending.push({ body, answer: resolve });
      }),
  });
  return { pending, store: createPreviewStore(client, () => 'person-1') };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the preview store', () => {
  it('asks once for a node and answers the second ask from the store', async () => {
    const { pending, store } = rig();
    const first = store.forNode(ref('W-1'), false);
    expect(store.forNode(ref('W-1'), false)).toBe(first);
    pending[0]?.answer({ ok: true, value: previewOf('W-1') });
    await settle();
    expect(first.getState()).toEqual({ phase: 'ready', data: previewOf('W-1') });
    expect(pending).toHaveLength(1);
  });

  it('asks again for another node, source, mask setting or person', () => {
    const { pending, store } = rig();
    store.forNode(ref('W-1'), false);
    store.forNode(ref('W-2'), false);
    store.forNode(ref('W-1', 'other'), false);
    store.forNode(ref('W-1'), true);
    expect(pending.map((entry) => `${entry.body.sourceId} ${entry.body.ref.stableId} ${entry.body.mask === true}`)).toEqual(['demo W-1 false', 'demo W-2 false', 'other W-1 false', 'demo W-1 true']);
    const other = createPreviewStore(fakeClient({ previewExpansion: (body) => new Promise((resolve) => void pending.push({ body, answer: resolve })) }), () => 'person-2');
    other.forNode(ref('W-1'), false);
    expect(pending).toHaveLength(5);
  });

  it('keeps a late answer under the node it was asked for and never shows it for another', async () => {
    const { pending, store } = rig();
    const first = store.forNode(ref('W-1'), false);
    const second = store.forNode(ref('W-2'), false);
    pending[1]?.answer({ ok: true, value: previewOf('W-2') });
    pending[0]?.answer({ ok: true, value: previewOf('W-1') });
    await settle();
    expect(first.getState()).toEqual({ phase: 'ready', data: previewOf('W-1') });
    expect(second.getState()).toEqual({ phase: 'ready', data: previewOf('W-2') });
  });

  it('holds a failure as a failure, and asks again on reload', async () => {
    const { pending, store } = rig();
    const request = store.forNode(ref('W-1'), false);
    pending[0]?.answer({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
    await settle();
    expect(request.getState()).toEqual({ phase: 'failed', failure: { code: 'NETWORK_UNAVAILABLE' } });
    request.reload();
    expect(pending).toHaveLength(2);
    pending[1]?.answer({ ok: true, value: previewOf('W-1') });
    await settle();
    expect(request.getState()).toMatchObject({ phase: 'ready' });
  });

  it('ends a cancelled ask without an error, and ignores its answer', async () => {
    const { pending, store } = rig();
    const request = store.forNode(ref('W-1'), false);
    request.cancel();
    pending[0]?.answer({ ok: false, failure: { code: 'ABORTED' } });
    await settle();
    expect(request.getState()).toEqual({ phase: 'idle' });
  });
});

describe('the preview store with a failure reporter', () => {
  const busy = { code: 'SOURCE_BUSY', message: 'busy', retryable: true, traceId: 't-1' } as const;

  function reporting() {
    const pending: Pending[] = [];
    const reported: { code: string; sourceId: string; resend: () => void }[] = [];
    const client = fakeClient({ previewExpansion: (body) => new Promise((resolve) => void pending.push({ body, answer: resolve })) });
    const store = createPreviewStore(client, () => 'person-1', (failure, sourceId, resend) => (reported.push({ code: failure.code, sourceId, resend }), true));
    return { pending, reported, store };
  }

  it('tells the reporter of a failure it keeps, with the source and a resend that asks again', async () => {
    const { pending, reported, store } = reporting();
    const request = store.forNode(ref('w1'), false);
    pending[0]?.answer({ ok: false, failure: busy });
    await settle();
    expect(reported.map(({ code, sourceId }) => ({ code, sourceId }))).toEqual([{ code: 'SOURCE_BUSY', sourceId: 'demo' }]);
    expect(request.getState()).toMatchObject({ phase: 'failed', failure: { code: 'SOURCE_BUSY' } });
    reported[0]?.resend();
    expect(pending).toHaveLength(2);
  });

  it('does not tell the reporter of a failure a newer ask made stale', async () => {
    const { pending, reported, store } = reporting();
    const request = store.forNode(ref('w1'), false);
    request.reload();
    pending[0]?.answer({ ok: false, failure: busy });
    pending[1]?.answer({ ok: true, value: previewOf('w1') });
    await settle();
    expect(reported).toEqual([]);
  });

  it('counts each answered preview once, and not a failure or a pending ask', async () => {
    const { pending, store } = rig();
    expect(store.answers.getState()).toBe(0);
    store.forNode(ref('W-1'), false);
    store.forNode(ref('W-2'), false);
    expect(store.answers.getState()).toBe(0);
    pending[0]?.answer({ ok: true, value: previewOf('W-1') });
    await settle();
    expect(store.answers.getState()).toBe(1);
    pending[1]?.answer({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
    await settle();
    expect(store.answers.getState()).toBe(1);
    store.forNode(ref('W-1'), false);
    expect(store.answers.getState()).toBe(1);
  });

  it('lets a check that waits for the menu\'s preview go on with no preview when the person cancels that preview', async () => {
    const { pending, store } = rig();
    const request = store.forNode(ref('W-1'), false);
    const waiting = store.settle(ref('W-1'), false);
    await settle();
    request.cancel();
    await expect(waiting).resolves.toBeUndefined();
    expect(pending).toHaveLength(1);
  });

  it('reads once more, quietly, for a check of a node whose menu preview was cancelled, and keeps nothing of that read', async () => {
    const { pending, store } = rig();
    store.forNode(ref('W-1'), false).cancel();
    const checking = store.settle(ref('W-1'), false);
    await settle();
    expect(pending).toHaveLength(2);
    pending[1]?.answer({ ok: true, value: previewOf('W-1') });
    await expect(checking).resolves.toEqual(previewOf('W-1'));
    expect(store.held(ref('W-1'), false)).toBeUndefined();
  });
});

describe('a check before an expansion whose preview gets no answer', () => {
  afterEach(() => void vi.useRealTimers());

  /** What the check ended with, or `waiting` while it has not ended. */
  const watched = (check: Promise<DegreePreview | undefined>) => {
    let ended: DegreePreview | 'none' | 'waiting' = 'waiting';
    void check.then((value) => (ended = value ?? 'none'));
    return () => ended;
  };

  it('ends at the bound when it made the read itself, and the next ask reads afresh', async () => {
    vi.useFakeTimers();
    const { pending, store } = rig();
    const check = watched(store.settle(ref('W-1'), false));
    await vi.advanceTimersByTimeAsync(READ_WAIT_MS - 1);
    expect(check()).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect(check()).toBe('none');
    const menu = store.forNode(ref('W-1'), false);
    expect(pending).toHaveLength(2);
    pending[1]?.answer({ ok: true, value: previewOf('W-1') });
    await vi.advanceTimersByTimeAsync(0);
    expect(menu.getState()).toMatchObject({ phase: 'ready' });
  });

  it('ends at the bound of the menu\u2019s read it waits for, which is kept as a failure that reload reads again', async () => {
    vi.useFakeTimers();
    const { pending, store } = rig();
    const menu = store.forNode(ref('W-1'), false);
    const check = watched(store.settle(ref('W-1'), false));
    await vi.advanceTimersByTimeAsync(READ_WAIT_MS - 1);
    expect(check()).toBe('waiting');
    expect(menu.getState()).toEqual({ phase: 'loading' });
    await vi.advanceTimersByTimeAsync(1);
    expect(check()).toBe('none');
    expect(menu.getState()).toEqual({ phase: 'failed', failure: { code: 'NETWORK_UNAVAILABLE' } });
    menu.reload();
    expect(pending).toHaveLength(2);
    expect(menu.getState()).toEqual({ phase: 'loading' });
  });

  it('ends at the bound of the quiet read made after a failed one, and a later check reads again', async () => {
    vi.useFakeTimers();
    const { pending, store } = rig();
    store.forNode(ref('W-1'), false);
    pending[0]?.answer({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
    await vi.advanceTimersByTimeAsync(0);
    const check = watched(store.settle(ref('W-1'), false));
    await vi.advanceTimersByTimeAsync(READ_WAIT_MS - 1);
    expect(check()).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect(check()).toBe('none');
    const later = watched(store.settle(ref('W-1'), false));
    expect(pending).toHaveLength(3);
    pending[2]?.answer({ ok: true, value: previewOf('W-1') });
    await vi.advanceTimersByTimeAsync(0);
    expect(later()).toEqual(previewOf('W-1'));
  });

  it('lets the expansion go ahead at the bound, and leaves it free to be asked again', async () => {
    vi.useFakeTimers();
    const anchor = ref('n1', 'a');
    let expansions = 0;
    const answer: ExpandResponse = { ref: { sourceId: 'a', entityType: 'widget', stableId: 'n1' }, pageSize: 25, nodes: [], edges: [], pages: [{ neighborType: 'kind-b', returned: 0, hasMore: false, matchingTotal: { quality: 'unknown', scope: 'x' } }], warnings: [] };
    const client = fakeClient({
      previewExpansion: () => new Promise<never>(() => undefined),
      expandNeighbors: async () => ((expansions += 1), { ok: true, value: answer }),
    });
    const state = createClientState();
    loadGraph(state, [{ ...node('a', 'n1'), ref: anchor }], []);
    const previews = createPreviewStore(client, () => 'person-1');
    const store = createExpandStore(client, state, () => 'person-1', undefined, createHeavyGuard(previews, createBannerController(), state));
    void store.expand(anchor, ['kind-b']);
    await vi.advanceTimersByTimeAsync(READ_WAIT_MS - 1);
    expect(store.of(anchor).status).toBe('loading');
    expect(expansions).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(expansions).toBe(1);
    expect(store.of(anchor).status).toBe('idle');
  });
});
