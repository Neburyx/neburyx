import type { ExpandResponse } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { edgeRef, node, ref } from '../state/test-data.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { createExpandStore } from './expand-store.js';
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
const answer: ExpandResponse = { ref: anchor, pageSize: 25, nodes: [nodeOf('type-a', 'n1'), nodeOf('kind-b', 'b-r1')], edges: [relation('r1')], pages: [{ neighborType: 'kind-b', returned: 1, hasMore: false, matchingTotal: { quality: 'unknown', scope: 'x' } }], warnings: [] };

function rig(focusOn: string) {
  const client = fakeClient({ expandNeighbors: () => Promise.resolve({ ok: true, value: answer }) });
  const state = createClientState();
  loadGraph(state, [nodeOf('type-a', 'n1'), nodeOf('type-a', 'n2')], []);
  state.focusOn(elementKey(ref('a', 'type-a', focusOn)));
  return { state, store: createExpandStore(client, state, () => 'person') };
}

describe('an expansion while focus is on', () => {
  it('tells a screen reader how many of the entities it loaded are outside focus, and selects only what is drawn', async () => {
    const { state, store } = rig('n2');
    await store.expand(anchor, ['kind-b']);
    expect(state.presentation.view.getState().moveNote?.text).toBe('1 of the 1 entity it loaded is outside focus.');
    expect(state.presentation.view.getState().selection.size).toBe(0);
    expect(state.loadedGraph().nodes).toHaveLength(3);
    expect(state.visibleGraph().nodes).toHaveLength(1);
  });

  it('says nothing and selects the new neighbor when what it loaded is inside focus', async () => {
    const { state, store } = rig('n1');
    await store.expand(anchor, ['kind-b']);
    expect(state.presentation.view.getState().moveNote).toBeUndefined();
    expect([...state.presentation.view.getState().selection]).toEqual([elementKey(ref('a', 'kind-b', 'b-r1')), expect.any(String)]);
    expect(state.visibleGraph().nodes).toHaveLength(2);
  });
});
