import type { ElementRef, ExpandRequest, ExpandResponse } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { edgeRef, node, ref } from '../state/test-data.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import type { ApiResult } from './client.js';
import { createExpandStore } from './expand-store.js';
import type { HeavyGuard, HeavyHold } from './heavy-guard.js';
import type { HeavyDecision } from './heavy-estimate.js';
import { fakeClient } from './fake-client.js';

const at = (type: string, id: string): ElementRef => ref('a', type, id);
const nodeOf = (type: string, id: string) => ({ ...node('a', id), ref: at(type, id), display: { title: id, type } });
const link = (id: string, from: ElementRef, to: ElementRef) => ({
  ref: edgeRef('a', id, 'link-a', from.entityType, to.entityType),
  from,
  to,
  type: 'link-a',
  direction: 'out' as const,
  semantics: 'stored' as const,
  properties: [],
  evidenceRefs: [],
  qualityFlags: [],
});

const A = at('type-a', 'A');
const B = at('kind-b', 'B');
const C = at('kind-b', 'C');
const D = at('type-a', 'D');

interface Reply {
  readonly neighbors: readonly ElementRef[];
  readonly cursor?: string;
}

/** An expansion of `anchor` returns the given neighbors, each joined to it by the edge `anchor>neighbor`; a neighbor equal to the anchor is a self-loop. */
function answerOf(anchor: ElementRef, reply: Reply): ExpandResponse {
  const types = [...new Set(reply.neighbors.map((neighbor) => neighbor.entityType))];
  return {
    ref: { sourceId: 'a', entityType: anchor.entityType, stableId: anchor.stableId },
    pageSize: 25,
    nodes: [nodeOf(anchor.entityType, anchor.stableId), ...reply.neighbors.map((neighbor) => nodeOf(neighbor.entityType, neighbor.stableId))],
    edges: reply.neighbors.map((neighbor) => link(`${anchor.stableId}>${neighbor.stableId}`, anchor, neighbor)),
    pages: types.map((type) => ({ neighborType: type, returned: 1, hasMore: reply.cursor !== undefined, ...(reply.cursor === undefined ? {} : { nextCursor: reply.cursor }), matchingTotal: { quality: 'unknown' as const, scope: 'x' } })),
    warnings: [],
  };
}

function rig(seed: readonly ElementRef[] = [A]) {
  const asked: ExpandRequest[] = [];
  const replies = new Map<string, Reply[]>();
  const client = fakeClient({
    expandNeighbors: (body) => {
      asked.push(body);
      const anchor = at(body.ref.entityType, body.ref.stableId);
      const next = replies.get(elementKey(anchor))?.shift() ?? { neighbors: [] };
      return Promise.resolve<ApiResult<ExpandResponse>>({ ok: true, value: answerOf(anchor, next) });
    },
  });
  const state = createClientState();
  loadGraph(state, seed.map((held) => nodeOf(held.entityType, held.stableId)), []);
  const store = createExpandStore(client, state, () => 'person');
  const reply = (anchor: ElementRef, ...next: Reply[]): void => void replies.set(elementKey(anchor), next);
  const nodes = (): string[] => state.loadedGraph().nodes.map((held) => held.ref.stableId).sort();
  const edges = (): string[] => state.loadedGraph().edges.map((held) => ('stableId' in held.ref ? held.ref.stableId : '')).sort();
  return { asked, state, store, reply, nodes, edges };
}

describe('collapsing a node', () => {
  it('removes the neighbors and relationships it loaded and keeps the node', async () => {
    const { store, reply, nodes, edges } = rig();
    reply(A, { neighbors: [B, C] });
    await store.expand(A, ['kind-b']);
    expect(nodes()).toEqual(['A', 'B', 'C']);
    expect(store.collapse(A)).toBe('collapsed');
    expect(nodes()).toEqual(['A']);
    expect(edges()).toEqual([]);
  });

  it('keeps a neighbor that was on the canvas before the expansion, and removes the relationship the expansion loaded', async () => {
    const { store, reply, nodes, edges } = rig([A, B]);
    reply(A, { neighbors: [B, C] });
    await store.expand(A, ['kind-b']);
    store.collapse(A);
    expect(nodes()).toEqual(['A', 'B']);
    expect(edges()).toEqual([]);
  });

  it('keeps a neighbor and its relationship while another node that returned them is expanded, and drops them with the last of them', async () => {
    const { store, reply, nodes, edges } = rig([A, D]);
    reply(A, { neighbors: [B] });
    reply(D, { neighbors: [B] });
    await store.expand(A, ['kind-b']);
    await store.expand(D, ['kind-b']);
    store.collapse(A);
    expect(nodes()).toEqual(['A', 'B', 'D']);
    expect(edges()).toEqual(['D>B']);
    store.collapse(D);
    expect(nodes()).toEqual(['A', 'D']);
    expect(edges()).toEqual([]);
  });

  it('keeps a neighbor the person asked for by another route while the expansion was on its way', async () => {
    const { store, reply, nodes } = rig();
    reply(A, { neighbors: [B, C] });
    await store.expand(A, ['kind-b']);
    store.keep(B);
    store.collapse(A);
    expect(nodes()).toEqual(['A', 'B']);
  });

  it('keeps a pinned neighbor, and keeps it for good when a later expansion returns it', async () => {
    const { store, reply, state, nodes } = rig([A, D]);
    reply(A, { neighbors: [B, C] });
    reply(D, { neighbors: [B] });
    await store.expand(A, ['kind-b']);
    state.presentation.pin([elementKey(B)]);
    store.collapse(A);
    expect(nodes()).toEqual(['A', 'B', 'D']);
    await store.expand(D, ['kind-b']);
    store.collapse(D);
    expect(nodes()).toEqual(['A', 'B', 'D']);
  });

  it('keeps a neighbor that was itself expanded, with what it loaded, and does not cascade', async () => {
    const { store, reply, nodes, edges } = rig();
    reply(A, { neighbors: [B, C] });
    reply(B, { neighbors: [A, D] });
    await store.expand(A, ['kind-b']);
    await store.expand(B, ['type-a']);
    expect(store.collapse(A)).toBe('collapsed');
    expect(nodes()).toEqual(['A', 'B', 'D']);
    expect(edges()).toEqual(['B>A', 'B>D']);
    store.collapse(B);
    expect(nodes()).toEqual(['A', 'B']);
  });

  it('takes back several pages, a start over and several types in one change of the canvas', async () => {
    const { store, reply, state, nodes } = rig();
    reply(A, { neighbors: [B], cursor: 'v1.c.m' }, { neighbors: [C], cursor: 'v1.c.m' }, { neighbors: [B] }, { neighbors: [D] });
    await store.expand(A, ['kind-b']);
    await store.loadMore(A, 'kind-b');
    await store.startOver(A, 'kind-b');
    await store.expand(A, ['type-a']);
    expect(nodes()).toEqual(['A', 'B', 'C', 'D']);
    let changes = 0;
    state.investigation.subscribe(() => (changes += 1));
    store.collapse(A);
    expect(changes).toBe(1);
    expect(nodes()).toEqual(['A']);
  });

  it('removes a relationship from the node to itself and keeps the node', async () => {
    const { store, reply, nodes, edges } = rig();
    reply(A, { neighbors: [A] });
    await store.expand(A, ['type-a']);
    expect(edges()).toEqual(['A>A']);
    store.collapse(A);
    expect(edges()).toEqual([]);
    expect(nodes()).toEqual(['A']);
  });

  it('leaves the other nodes where they are, and forgets a selection of what went', async () => {
    const { store, reply, state } = rig([A, D]);
    reply(A, { neighbors: [B] });
    await store.expand(A, ['kind-b']);
    state.presentation.setPositions(new Map([[elementKey(A), { x: 1, y: 2 }], [elementKey(D), { x: 3, y: 4 }], [elementKey(B), { x: 5, y: 6 }]]));
    state.presentation.select([elementKey(B), edgeKey(edgeRef('a', 'A>B', 'link-a', 'type-a', 'kind-b'))]);
    store.collapse(A);
    const { positions, selection } = state.presentation.view.getState();
    expect([...positions]).toEqual([[elementKey(A), { x: 1, y: 2 }], [elementKey(D), { x: 3, y: 4 }]]);
    expect(selection.size).toBe(0);
  });

  it('sends no request, with masking on as with masking off', async () => {
    for (const mask of [false, true]) {
      const { store, reply, state, asked, nodes } = rig();
      state.setMask(mask);
      reply(A, { neighbors: [B, C] });
      await store.expand(A, ['kind-b']);
      const before = asked.length;
      store.collapse(A);
      expect(asked.length).toBe(before);
      expect(nodes()).toEqual(['A']);
    }
  });

  it('asks for the first page again afterwards, with no cursor and no relationship types of the earlier chain, and keeps the page size', async () => {
    const { store, reply, asked } = rig();
    reply(A, { neighbors: [B], cursor: 'v1.c.m' }, { neighbors: [B] });
    store.setPageSize(A, 10);
    await store.expand(A, ['kind-b'], ['link-a']);
    store.collapse(A);
    expect(store.of(A).types.size).toBe(0);
    expect(store.relTypesOf(A, 'kind-b')).toBeUndefined();
    await store.expand(A, ['kind-b']);
    expect(asked[1]).not.toHaveProperty('cursors');
    expect(asked[1]).not.toHaveProperty('relTypes');
    expect(asked[1]?.limit).toBe(10);
  });

  it('refuses a node nothing was loaded from, a node already collapsed, and does not bring the record back when the masking is changed and changed back', async () => {
    const { store, reply, state, nodes } = rig();
    expect(store.collapse(A)).toBe('nothing');
    reply(A, { neighbors: [B] });
    await store.expand(A, ['kind-b']);
    expect(store.collapsibility(A)).toBe('yes');
    store.collapse(A);
    expect(store.collapse(A)).toBe('nothing');
    reply(A, { neighbors: [B] });
    await store.expand(A, ['kind-b']);
    state.setMask(true);
    state.setMask(false);
    expect(store.collapsibility(A)).toBe('nothing');
    expect(store.collapse(A)).toBe('nothing');
    expect(nodes()).toContain('A');
  });

  it('is off while an ask for the node is running', async () => {
    const release: { go?: () => void } = {};
    const state = createClientState();
    loadGraph(state, [nodeOf('type-a', 'A')], []);
    const client = fakeClient({ expandNeighbors: () => new Promise((resolve) => (release.go = () => resolve({ ok: true, value: answerOf(A, { neighbors: [B] }) }))) });
    const store = createExpandStore(client, state, () => 'person');
    const running = store.expand(A, ['kind-b']);
    expect(store.collapsibility(A)).toBe('loading');
    release.go?.();
    await running;
    expect(store.collapsibility(A)).toBe('yes');
  });

  it('takes down a heavy-operation warning waiting for the node, so Continue sends nothing afterwards', async () => {
    const asked: ExpandRequest[] = [];
    const client = fakeClient({
      expandNeighbors: (body) => {
        asked.push(body);
        return Promise.resolve<ApiResult<ExpandResponse>>({ ok: true, value: answerOf(A, { neighbors: [B] }) });
      },
    });
    const state = createClientState();
    loadGraph(state, [nodeOf('type-a', 'A')], []);
    let decision: HeavyDecision = { kind: 'none' };
    let held: HeavyHold | undefined;
    const released: ElementRef[] = [];
    const heavy: HeavyGuard = { decide: () => Promise.resolve(decision), hold: (next) => void (held = next), release: (target) => void released.push(target) };
    const store = createExpandStore(client, state, () => 'person', undefined, heavy);
    await store.expand(A, ['kind-b']);
    decision = { kind: 'heavy', estimate: { value: 900, quality: 'exact' } as never, threshold: 500, pageSize: 25 };
    await expect(store.expand(A, ['kind-b'])).resolves.toBe('held');
    expect(store.collapse(A)).toBe('collapsed');
    expect(released).toContainEqual(A);
    held?.proceed();
    await Promise.resolve();
    expect(asked).toHaveLength(1);
  });

  it('does not let a banner Retry made before the collapse send the old ask afterwards', async () => {
    const asked: ExpandRequest[] = [];
    let at = 0;
    const client = fakeClient({
      expandNeighbors: (body) => {
        asked.push(body);
        at += 1;
        return Promise.resolve<ApiResult<ExpandResponse>>(at === 2 ? { ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'x', retryable: true, traceId: 't' } } : { ok: true, value: answerOf(A, { neighbors: [B], cursor: 'v1.c.m' }) });
      },
    });
    const state = createClientState();
    loadGraph(state, [nodeOf('type-a', 'A')], []);
    let resend: (() => void) | undefined;
    const store = createExpandStore(client, state, () => 'person', (_failure, _source, again) => {
      resend = again;
      return true;
    });
    await store.expand(A, ['kind-b']);
    await store.loadMore(A, 'kind-b');
    expect(resend).toBeDefined();
    store.collapse(A);
    resend?.();
    await Promise.resolve();
    expect(asked).toHaveLength(2);
  });

  it('does not bring the record back when the investigation is switched and switched back', async () => {
    const state = createClientState();
    const showing = (id: string) => {
      const key = { sourceId: 'a', principalId: 'p', policyVersion: 'community', filterHash: 'none', params: `open-${id}`, mask: false };
      return state.show({ id, sourceId: 'a', record: { title: id, caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [key], nodeRefs: [A], edgeRefs: [] }, [{ key, result: { sourceId: 'a', nodes: [nodeOf('type-a', 'A')], edges: [] } }]);
    };
    const client = fakeClient({ expandNeighbors: () => Promise.resolve<ApiResult<ExpandResponse>>({ ok: true, value: answerOf(A, { neighbors: [B] }) }) });
    showing('inv-1');
    const store = createExpandStore(client, state, () => 'person');
    await store.expand(A, ['kind-b']);
    expect(store.collapsibility(A)).toBe('yes');
    showing('inv-2');
    expect(state.resume('inv-1', false)).toBe('resumed');
    expect(store.collapsibility(A)).toBe('nothing');
    expect(store.collapse(A)).toBe('nothing');
    expect(state.loadedGraph().nodes.map((held) => held.ref.stableId).sort()).toEqual(['A', 'B']);
  });
});
