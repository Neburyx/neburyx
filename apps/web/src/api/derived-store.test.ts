import { describe, expect, it } from 'vitest';
import type { DerivedNeighborsResponse, GraphEdge } from '@neburyx/contracts';
import { createClientState } from '../state/client-state.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { node, ref } from '../state/test-data.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { fakeClient } from './fake-client.js';
import { createDerivedStore } from './derived-store.js';

const origin = ref('a', 'type-a', 'n1');
const edgeTo = (id: string): GraphEdge => ({
  ref: { sourceId: 'a', derived: { ruleId: 'r', from: origin, to: ref('a', 'type-a', id) } },
  from: origin,
  to: ref('a', 'type-a', id),
  type: 'r',
  direction: 'from-to',
  semantics: 'derived',
  derivation: { ruleId: 'r', ruleVersion: 1, supportingEdgeRefs: [] },
  properties: [],
  evidenceRefs: [],
  qualityFlags: [],
});
const answer: DerivedNeighborsResponse = { ref: origin, results: [{ ruleId: 'r', ruleVersion: 1, count: { value: 1, quality: 'exact', scope: 's' }, nodes: [node('a', 'n2')], edges: [edgeTo('n2')], warnings: [] }] };

function rig(respond: () => Promise<{ ok: true; value: DerivedNeighborsResponse } | { ok: false; failure: never }> = () => Promise.resolve({ ok: true, value: answer })) {
  const state = createClientState();
  loadGraph(state, [node('a', 'n1')], []);
  const calls: unknown[] = [];
  const investigation = { id: 'inv-1' };
  const client = fakeClient({ derivedNeighbors: (request) => (calls.push(request), respond()) });
  return { state, calls, investigation, store: createDerivedStore(client, state, () => 'person-1', () => investigation.id) };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the derived neighbors store', () => {
  it('asks once for a node and masking setting, and keeps the answer for the session', async () => {
    const { store, calls } = rig();
    const first = store.forNode(origin, false);
    expect(store.forNode(origin, false)).toBe(first);
    await settled();
    expect(calls).toHaveLength(1);
    expect(store.held(origin, 'r')?.count).toMatchObject({ value: 1 });
  });

  it('keeps a request of its own for each person and masking setting', async () => {
    const { store, calls } = rig();
    store.forNode(origin, false);
    store.forNode(origin, true);
    await settled();
    expect(calls).toEqual([expect.not.objectContaining({ mask: true }), expect.objectContaining({ mask: true })]);
  });

  it('keeps a request of its own for each investigation', async () => {
    const { store, calls, investigation } = rig();
    store.forNode(origin, false);
    investigation.id = 'inv-2';
    store.forNode(origin, false);
    await settled();
    expect(calls).toHaveLength(2);
    expect(store.held(origin, 'r')).toBeDefined();
    investigation.id = 'inv-3';
    expect(store.held(origin, 'r')).toBeUndefined();
  });

  it('holds nothing for a failed read, and nothing is shown for it', async () => {
    const { store, state } = rig(() => Promise.resolve({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } as never }));
    store.forNode(origin, false);
    await settled();
    expect(store.held(origin, 'r')).toBeUndefined();
    expect(store.show(origin, 'r')).toBeUndefined();
    expect(state.loadedGraph().nodes).toHaveLength(1);
  });

  it('shows the nodes and edges the view does not hold, once, and leaves the selection alone', async () => {
    const { store, state } = rig();
    store.forNode(origin, false);
    await settled();
    state.presentation.select([elementKey(origin)]);
    expect(store.show(origin, 'r')).toEqual({ nodes: 1, edges: 1 });
    expect(store.show(origin, 'r')).toEqual({ nodes: 0, edges: 0 });
    expect(state.loadedGraph().nodes.map((entry) => entry.ref.stableId).sort()).toEqual(['n1', 'n2']);
    expect(state.loadedGraph().edges.map((edge) => edgeKey(edge.ref))).toEqual([edgeKey(edgeTo('n2').ref)]);
    expect(state.presentation.view.getState().selection).toEqual(new Set([elementKey(origin)]));
  });
});
