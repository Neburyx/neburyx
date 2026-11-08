import type { DegreePreview, DegreePreviewRequest, ExpandRequest, ExpandResponse } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { bannerReporter } from '../banner/banner-reporter.js';
import { bindBannerToInvestigation } from '../banner/bind-investigation.js';
import { createBuiltInBannerController } from '../banner/built-in-causes.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { edgeRef, node, ref } from '../state/test-data.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import type { ApiFailure, ApiResult } from './client.js';
import { createExpandStore } from './expand-store.js';
import { fakeClient } from './fake-client.js';
import { createPreviewStore } from './preview-store.js';

const anchor = ref('a', 'type-a', 'n1');
const nodeOf = (type: string, id: string) => ({ ...node('a', id), ref: ref('a', type, id), display: { title: id, type } });
const relation = (id: string) => ({
  ref: edgeRef('a', id, 'link-a', 'type-a', 'kind-b'),
  from: anchor,
  to: ref('a', 'kind-b', `b-${id}`),
  type: 'link-a',
  direction: 'out' as const,
  semantics: 'stored' as const,
  properties: [],
  evidenceRefs: [],
  qualityFlags: [],
});
const page = (cursor: string | undefined) => ({ neighborType: 'kind-b', returned: 1, hasMore: cursor !== undefined, ...(cursor === undefined ? {} : { nextCursor: cursor }), matchingTotal: { quality: 'unknown' as const, scope: 'x' } });
const answer = (id: string, cursor?: string): ExpandResponse => ({ ref: anchor, pageSize: 25, nodes: [nodeOf('type-a', 'n1'), nodeOf('kind-b', `b-${id}`)], edges: [relation(id)], pages: [page(cursor)], warnings: [] });
const timedOut: ApiFailure = { code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: 'tr-t', details: { timeoutMs: 5000 } };

interface Asked<B, T> {
  readonly body: B;
  answer(result: ApiResult<T>): void;
}

function rig() {
  const expansions: Asked<ExpandRequest, ExpandResponse>[] = [];
  const previews: Asked<DegreePreviewRequest, DegreePreview>[] = [];
  const asking = <B, T>(list: Asked<B, T>[]) => (body: B) => new Promise<ApiResult<T>>((resolve) => void list.push({ body, answer: resolve }));
  const state = createClientState();
  loadGraph(state, [nodeOf('type-a', 'n1')], []);
  const banner = createBuiltInBannerController();
  bindBannerToInvestigation(state, banner);
  const base = fakeClient({ expandNeighbors: asking(expansions), previewExpansion: asking(previews) });
  const sent: string[] = [];
  const client = new Proxy(base, {
    get(target, name, receiver) {
      const member: unknown = Reflect.get(target, name, receiver);
      if (typeof member !== 'function' || typeof name !== 'string') return member;
      return (...args: unknown[]) => {
        sent.push(name);
        return (member as (...given: unknown[]) => unknown)(...args);
      };
    },
  });
  const report = bannerReporter(banner, () => 'Demo source');
  return { state, banner, expansions, previews, sent, expand: createExpandStore(client, state, () => 'person', report), preview: createPreviewStore(client, () => 'person', report) };
}

const snapshot = (state: ClientState) => JSON.stringify({ investigation: state.investigation.getState(), presentation: state.presentation.view.getState(), graph: state.loadedGraph() });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a request that times out', () => {
  it('leaves the loaded graph, filters, selection and draft as data, and the cursor where it was, for an expansion, a Load more and a degree preview', async () => {
    const { state, expand, preview, expansions, previews, sent } = rig();
    const first = expand.expand(anchor, ['kind-b']);
    expansions[0]?.answer({ ok: true, value: answer('r1', 'v1.next') });
    await first;
    const before = snapshot(state);
    const progress = JSON.stringify([...expand.of(anchor).types]);

    const more = expand.loadMore(anchor, 'kind-b');
    expansions[1]?.answer({ ok: false, failure: timedOut });
    expect(await more).toBe('failed');
    expect(snapshot(state)).toBe(before);
    expect(JSON.stringify([...expand.of(anchor).types])).toBe(progress);
    expect(expand.of(anchor).types.get('kind-b')?.cursor).toBe('v1.next');

    const again = expand.expand(anchor, ['kind-b']);
    expansions[2]?.answer({ ok: false, failure: timedOut });
    expect(await again).toBe('failed');
    expect(snapshot(state)).toBe(before);

    preview.forNode(anchor, false);
    previews[0]?.answer({ ok: false, failure: timedOut });
    await settle();
    expect(snapshot(state)).toBe(before);
    expect(state.investigation.getState()).toEqual(JSON.parse(before).investigation);
    expect(new Set(sent)).toEqual(new Set(['expandNeighbors', 'previewExpansion']));
  });

  it('merges the page once when Retry is pressed and the source answers, with no duplicate node or relationship', async () => {
    const { state, banner, expand, expansions } = rig();
    const asked = expand.expand(anchor, ['kind-b']);
    expansions[0]?.answer({ ok: false, failure: timedOut });
    await asked;
    const retry = banner.view.getState().banner?.actions.find((action) => action.id === 'retry');
    retry?.run();
    retry?.run();
    expect(expansions).toHaveLength(2);
    expansions[1]?.answer({ ok: true, value: answer('r1') });
    await settle();
    const graph = state.loadedGraph();
    expect(graph.nodes.map((each) => each.ref.stableId).sort()).toEqual(['b-r1', 'n1']);
    expect(graph.edges).toHaveLength(1);
  });

  it('shows no banner and changes nothing when a newer ask for the same node was sent meanwhile', async () => {
    const { state, banner, expand, expansions } = rig();
    void expand.expand(anchor, ['kind-b']);
    void expand.expand(anchor, ['kind-b']);
    const before = snapshot(state);
    expansions[0]?.answer({ ok: false, failure: timedOut });
    await settle();
    expect(banner.view.getState().banner).toBeUndefined();
    expect(snapshot(state)).toBe(before);
    expansions[1]?.answer({ ok: true, value: answer('r2') });
    await settle();
    expect(state.loadedGraph().nodes.map((each) => each.ref.stableId).sort()).toEqual(['b-r2', 'n1']);
  });
});
