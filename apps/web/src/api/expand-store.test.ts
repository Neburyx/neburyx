import type { ExpandRequest, ExpandResponse } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { edgeRef, node, ref } from '../state/test-data.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import type { ApiResult } from './client.js';
import { NOTHING_NEW, PAGE_CEILING, createExpandStore } from './expand-store.js';
import { fakeClient } from './fake-client.js';

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
const page = (cursor: string | undefined, returned = 1) => ({ neighborType: 'kind-b', returned, hasMore: cursor !== undefined, ...(cursor === undefined ? {} : { nextCursor: cursor }), matchingTotal: { quality: 'unknown' as const, scope: 'x' } });
const answer = (id: string, cursor?: string): ExpandResponse => ({ ref: { sourceId: 'a', entityType: 'type-a', stableId: 'n1' }, pageSize: 25, nodes: [nodeOf('type-a', 'n1'), nodeOf('kind-b', `b-${id}`)], edges: [relation(id)], pages: [page(cursor)], warnings: [] });
const refused = (code: 'QUERY_BUDGET_EXCEEDED' | 'CURSOR_INVALIDATED', maxPage?: number): ApiResult<ExpandResponse> => ({ ok: false, failure: { code, message: 'x', retryable: false, traceId: 't', ...(maxPage === undefined ? {} : { details: { maxPage } }) } });

function rig(reply: (body: ExpandRequest, at: number) => ApiResult<ExpandResponse>) {
  const asked: ExpandRequest[] = [];
  const client = fakeClient({
    expandNeighbors: (body) => {
      asked.push(body);
      return Promise.resolve(reply(body, asked.length));
    },
  });
  const state = createClientState();
  loadGraph(state, [nodeOf('type-a', 'n1')], []);
  return { asked, state, store: createExpandStore(client, state, () => 'person') };
}
const ok = (value: ExpandResponse): ApiResult<ExpandResponse> => ({ ok: true, value });

describe('a page size on an expansion', () => {
  it('sends no limit until the person has set one, from every way of asking', async () => {
    const { asked, store } = rig((_, at) => ok(answer(`r${at}`, 'v1.c.m')));
    await store.expand(anchor, ['kind-b']);
    await store.loadMore(anchor, 'kind-b');
    expect(asked.map((body) => 'limit' in body)).toEqual([false, false]);
  });

  it('sends the page size the person set with the first page and with every later page', async () => {
    const { asked, store } = rig((_, at) => ok(answer(`r${at}`, at < 3 ? 'v1.c.m' : undefined)));
    expect(store.setPageSize(anchor, 10)).toEqual({ ok: true, value: 10 });
    await store.expand(anchor, ['kind-b']);
    await store.loadMore(anchor, 'kind-b');
    await store.startOver(anchor, 'kind-b');
    expect(asked.map((body) => body.limit)).toEqual([10, 10, 10]);
    expect(store.of(anchor).chosenPageSize).toBe(10);
  });

  it.each([
    [0, 'below-one'],
    [-3, 'below-one'],
    [2.5, 'not-whole'],
    [Number.NaN, 'not-whole'],
    [PAGE_CEILING + 1, 'above-ceiling'],
  ] as const)('keeps nothing and says why for %s', (value, reason) => {
    const { store } = rig(() => refused('CURSOR_INVALIDATED'));
    store.setPageSize(anchor, 12);
    expect(store.setPageSize(anchor, value)).toEqual({ ok: false, reason, ceiling: PAGE_CEILING });
    expect(store.of(anchor).chosenPageSize).toBe(12);
  });

  it('lowers the ceiling of the source and the page size to the maxPage a refusal names, merges nothing, and can ask again at once', async () => {
    const { asked, state, store } = rig((body) => (body.limit === 40 ? refused('QUERY_BUDGET_EXCEEDED', 30) : ok(answer('r1'))));
    store.setPageSize(anchor, 40);
    await store.expand(anchor, ['kind-b']);
    expect(store.of(anchor)).toMatchObject({ status: 'failed', chosenPageSize: 30 });
    expect(store.ceilingOf('a')).toBe(30);
    expect(store.ceilingOf('another')).toBe(PAGE_CEILING);
    expect(state.loadedGraph().edges).toHaveLength(0);
    expect(store.setPageSize(anchor, 31)).toMatchObject({ ok: false, reason: 'above-ceiling', ceiling: 30 });
    await store.retry(anchor);
    expect(asked.map((body) => body.limit)).toEqual([40, 30]);
    expect(store.of(anchor).status).toBe('idle');
    expect(state.loadedGraph().edges).toHaveLength(1);
  });

  it('keeps the loaded graph and the chosen page size when a request fails', async () => {
    const { state, store } = rig((_, at) => (at === 1 ? ok(answer('r1', 'v1.c.m')) : refused('CURSOR_INVALIDATED')));
    store.setPageSize(anchor, 7);
    await store.expand(anchor, ['kind-b']);
    await store.loadMore(anchor, 'kind-b');
    expect(store.of(anchor)).toMatchObject({ status: 'failed', chosenPageSize: 7 });
    expect(state.loadedGraph().edges).toHaveLength(1);
  });
});

describe('relationship types on an expansion', () => {
  it('sends relTypes and the one sort with the asked types, and none for all sourced types', async () => {
    const { asked, store } = rig((_, at) => ok(answer(`r${at}`)));
    await store.expand(anchor, ['kind-b'], ['link-a']);
    await store.expand(anchor, ['kind-b']);
    expect(asked[0]).toMatchObject({ relTypes: ['link-a'], sort: 'observed' });
    expect(asked[1]).not.toHaveProperty('relTypes');
  });

  it('continues a chain with the relationship types it began with, and a new ask over other types begins a new chain', async () => {
    const { asked, store } = rig((_, at) => ok(answer(`r${at}`, 'v1.c.m')));
    await store.expand(anchor, ['kind-b'], ['link-a']);
    expect(store.relTypesOf(anchor, 'kind-b')).toEqual(['link-a']);
    await store.loadMore(anchor, 'kind-b');
    expect(asked[1]?.relTypes).toEqual(['link-a']);
    expect(asked[1]?.cursors).toEqual({ 'kind-b': 'v1.c.m' });
    await store.startOver(anchor, 'kind-b');
    expect(asked[2]?.relTypes).toEqual(['link-a']);
    await store.expand(anchor, ['kind-b']);
    expect(store.relTypesOf(anchor, 'kind-b')).toBeUndefined();
    await store.loadMore(anchor, 'kind-b');
    expect(asked[4]).not.toHaveProperty('relTypes');
  });

  it('keeps the chain of a type when the ask over other relationship types fails', async () => {
    const { store } = rig((_, at) => (at === 1 ? ok(answer('r1', 'v1.c.m')) : refused('CURSOR_INVALIDATED')));
    await store.expand(anchor, ['kind-b'], ['link-a']);
    await store.expand(anchor, ['kind-b']);
    expect(store.relTypesOf(anchor, 'kind-b')).toEqual(['link-a']);
  });
});

describe('a load that finds nothing new', () => {
  it('says so when every entity and relationship of the answer is already on the canvas, and not when the answer adds one', async () => {
    const { store } = rig((_, at) => ok(answer('same', at < 3 ? 'v1.c.m' : undefined)));
    await store.expand(anchor, ['kind-b']);
    expect(store.notes.getState()).toEqual([]);
    await store.loadMore(anchor, 'kind-b');
    expect(store.notes.getState()).toEqual([NOTHING_NEW]);
    expect(store.of(anchor).types.get('kind-b')?.hasMore).toBe(true);
    expect(NOTHING_NEW).toBe('Nothing new: every neighbor on this page is already on the canvas');
  });

  it('does not say it for a node with no relationships, whose answer holds only the node itself, and clears the note when the next load starts', async () => {
    const empty: ExpandResponse = { ...answer('x'), nodes: [nodeOf('type-a', 'n1')], edges: [] };
    const { store } = rig((_, at) => ok(at === 1 ? answer('same', 'v1.c.m') : at === 2 ? answer('same', 'v1.c.m') : empty));
    await store.expand(anchor, ['kind-b']);
    await store.loadMore(anchor, 'kind-b');
    expect(store.notes.getState()).toEqual([NOTHING_NEW]);
    await store.loadMore(anchor, 'kind-b');
    expect(store.notes.getState()).toEqual([]);
  });

  it('says nothing for the nodes of a batch of several, even when the last one finds nothing new after an earlier one added something', async () => {
    const { store } = rig(() => ok(answer('first')));
    const batch = { waiting: 2, size: 2, after: () => Promise.resolve() };
    await store.expand(anchor, ['kind-b'], undefined, batch);
    await store.expand(anchor, ['kind-b'], undefined, { ...batch, waiting: 1 });
    expect(store.notes.getState()).toEqual([]);
  });

  it('says it for a batch of one node, as the selection action sends it, and keeps the note about the filters that was shown with the load', async () => {
    const { store } = rig(() => ok(answer('first')));
    const batch = { waiting: 1, size: 1, after: () => Promise.resolve() };
    await store.expand(anchor, ['kind-b'], undefined, batch);
    const pending = store.expand(anchor, ['kind-b'], undefined, batch);
    store.report('Narrowed by the filters.');
    await pending;
    expect(store.notes.getState()).toEqual(['Narrowed by the filters.', NOTHING_NEW]);
  });
});
