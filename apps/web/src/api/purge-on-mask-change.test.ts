import type { DegreePreview, DerivedNeighborsResponse, GraphNode } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createEntityReadStore } from '../inspector/entity-read.js';
import { failure } from '../patterns/patterns-kit.js';
import { bannerReporter } from '../banner/banner-reporter.js';
import { createBuiltInBannerController } from '../banner/built-in-causes.js';
import { createClientState } from '../state/client-state.js';
import { node, ref } from '../state/test-data.js';
import { previewOf } from '../workspace/supernode-kit.js';
import type { ApiResult } from './client.js';
import { createCoverageStore } from './coverage-store.js';
import { createDerivedStore } from './derived-store.js';
import { fakeClient } from './fake-client.js';
import { createPreviewStore } from './preview-store.js';
import { purgeOnMaskChange } from './purge-on-mask-change.js';

const at = ref('a', 'type-a', 'n1');
const answered = <T,>(value: T): Promise<ApiResult<T>> => Promise.resolve({ ok: true, value });
const never = <T,>(): Promise<ApiResult<T>> => new Promise<ApiResult<T>>(() => undefined);
const named = (title: string): GraphNode => ({ ...node('a', 'n1'), display: { title, type: 'type-a' } });
const derivedAnswer: DerivedNeighborsResponse = { ref: at, results: [] };

function rig(loading: boolean) {
  const signals: Array<AbortSignal | undefined> = [];
  const client = fakeClient({
    getEntity: (_ref, _opts, signal) => (signals.push(signal), loading ? never<GraphNode>() : answered(named('Ana Silva'))),
    previewExpansion: (_request, signal) => (signals.push(signal), loading ? never<DegreePreview>() : answered(previewOf())),
    derivedNeighbors: (_request, signal) => (signals.push(signal), loading ? never<DerivedNeighborsResponse>() : answered(derivedAnswer)),
    graphCoverage: (_request, signal) => (signals.push(signal), loading ? never() : answered({ notRetrieved: { quality: 'unknown' as const, scope: 'x' }, uncounted: 0 })),
  });
  const state = createClientState();
  state.bindSource('a');
  const entities = createEntityReadStore(client, () => 'p', () => 'i');
  const previews = createPreviewStore(client, () => 'p');
  const derived = createDerivedStore(client, state, () => 'p', () => 'i');
  const coverage = createCoverageStore(client, () => 'p');
  purgeOnMaskChange(state, [entities, previews, derived, coverage]);
  const handles = {
    entity: entities.forEntity(at, false),
    preview: previews.forNode(at, false),
    derived: derived.forNode(at, false),
    coverage: coverage.forGraph({ sourceId: 'a', mask: false, previewAnswers: 0, entities: [{ ref: at, loadedRelationships: 0, loadedQuality: 'exact' }] }),
  };
  return { state, signals, handles, previews, entities };
}

const settle = () => new Promise<void>((done) => setTimeout(done, 0));

describe('the stores of the session when the masking setting changes', () => {
  it('hold nothing of an answered read, and a handle taken before holds no data either', async () => {
    const { state, handles, previews } = rig(false);
    await settle();
    expect(handles.entity.getState()).toMatchObject({ phase: 'ready', data: { display: { title: 'Ana Silva' } } });
    expect(previews.held(at, false)).toBeDefined();
    state.setMask(true);
    for (const handle of [handles.entity, handles.preview, handles.derived, handles.coverage]) expect(handle?.getState()).toEqual({ phase: 'idle' });
    expect(previews.held(at, false)).toBeUndefined();
  });

  it('cancel a read that is still on its way, and keep nothing of it', () => {
    const { state, signals, handles } = rig(true);
    expect(signals).toHaveLength(4);
    state.setMask(true);
    expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
    for (const handle of [handles.entity, handles.preview, handles.derived, handles.coverage]) expect(handle?.getState()).toEqual({ phase: 'idle' });
  });

  it('ask again for a node under the new setting with a read of their own, and do nothing when the setting is the one it was', async () => {
    const { state, entities, handles } = rig(false);
    await settle();
    state.setMask(false);
    expect(handles.entity.getState().phase).toBe('ready');
    state.setMask(true);
    expect(entities.forEntity(at, true)).not.toBe(handles.entity);
    expect(entities.forEntity(at, true).getState().phase).toBe('loading');
  });

  it('leave a retry kept from before dead: it sends nothing, with the old setting or any', async () => {
    const sent: Array<boolean | undefined> = [];
    const client = fakeClient({ previewExpansion: async (request) => (sent.push(request.mask), { ok: false, failure: failure('RATE_LIMITED') }) });
    const retries: Array<() => void> = [];
    const state = createClientState();
    const previews = createPreviewStore(client, () => 'p', (_failure, _sourceId, reload) => (retries.push(reload), true));
    purgeOnMaskChange(state, [previews]);
    previews.forNode(at, false);
    await settle();
    expect(retries).toHaveLength(1);
    state.setMask(true);
    retries[0]?.();
    await settle();
    expect(sent).toEqual([undefined]);
  });

  it('take the failure banner of a read that was dropped off the screen, so that no Retry is left for it', async () => {
    const client = fakeClient({ previewExpansion: async () => ({ ok: false, failure: failure('SOURCE_BUSY') }) });
    const banner = createBuiltInBannerController();
    const state = createClientState();
    const previews = createPreviewStore(client, () => 'p', bannerReporter(banner, () => 'Source'));
    purgeOnMaskChange(state, [previews, { clear: () => banner.clear() }]);
    previews.forNode(at, false);
    await settle();
    expect(banner.view.getState().banner).toBeDefined();
    state.setMask(true);
    expect(banner.view.getState().banner).toBeUndefined();
  });
});
