import type { ExpandRequest, ExpandResponse } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { createExpandStore } from '../api/expand-store.js';
import { fakeClient } from '../api/fake-client.js';
import { placeNewEntities } from '../canvas/incremental-layout.js';
import { NEIGHBOUR_REACH } from '../canvas/layout-constants.js';
import { createClientState } from '../state/client-state.js';
import { edgeRef, node, ref } from '../state/test-data.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { groupAllByType } from './group-actions.js';
import { placementPositions } from './group-placement.js';

const anchor = ref('a', 'type-a', 'n1');
const nodeOf = (type: string, id: string) => ({ ...node('a', id), ref: ref('a', type, id), display: { title: id, type } });
const reply: ExpandResponse = {
  ref: { sourceId: 'a', entityType: 'type-a', stableId: 'n1' },
  pageSize: 25,
  nodes: [nodeOf('type-a', 'n1'), nodeOf('kind-b', 'b1')],
  edges: [{ ref: edgeRef('a', 'r1', 'link-a', 'type-a', 'kind-b'), from: anchor, to: ref('a', 'kind-b', 'b1'), type: 'link-a', direction: 'out', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] }],
  pages: [{ neighborType: 'kind-b', returned: 1, hasMore: false, matchingTotal: { quality: 'unknown', scope: 'x' } }],
  warnings: [],
};

function rig(result: ApiResult<ExpandResponse>) {
  const asked: ExpandRequest[] = [];
  const client = fakeClient({ expandNeighbors: (body) => { asked.push(body); return Promise.resolve(result); } });
  const state = createClientState();
  loadGraph(state, [nodeOf('type-a', 'n1')], []);
  groupAllByType(state);
  return { asked, state, store: createExpandStore(client, state, () => 'person') };
}

describe('Expand on a grouped view', () => {
  it('sends the same request as without groups', async () => {
    const { asked, store } = rig({ ok: true, value: reply });
    await store.expand(anchor, ['kind-b']);
    expect(asked).toHaveLength(1);
    expect(JSON.stringify(asked[0])).not.toContain('group');
  });

  it('leaves the groups as they were when the request fails or is refused', async () => {
    const { state, store } = rig({ ok: false, failure: { code: 'QUERY_BUDGET_EXCEEDED', message: 'x', retryable: false, traceId: 't' } });
    const before = state.presentation.view.getState().groups;
    await store.expand(anchor, ['kind-b']);
    expect(state.presentation.view.getState().groups).toBe(before);
    expect(state.loadedGraph().nodes).toHaveLength(1);
  });

  it('places a new neighbor of a collapsed member near its card', () => {
    const positions = new Map([['a', { x: 1000, y: 1000 }], ['b', { x: 1200, y: 1000 }]]);
    const groups = [{ id: 'g', by: 'entityType', members: ['a', 'b'], collapsed: true }];
    const placed = placeNewEntities({ ids: ['a', 'b', 'new'], links: [['a', 'new']], positions: placementPositions(positions, groups) });
    const spot = placed.get('new');
    expect(spot).toBeDefined();
    expect(Math.hypot((spot?.x ?? 0) - 1100, (spot?.y ?? 0) - 1000)).toBeLessThanOrEqual(NEIGHBOUR_REACH);
  });
});
