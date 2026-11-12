import { act, renderHook } from '@testing-library/react';
import type { Count, EdgeDetail, GraphEdge } from '@neburyx/contracts';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { fakeClient } from '../api/fake-client.js';
import { createEdgeReadStore, EdgeReadProvider } from '../evidence/edge-read.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider, useLoadedGraph } from '../state/context.js';
import { edge, key, node, ref } from '../state/test-data.js';
import { useDisplayGraph } from './use-display-graph.js';

const from = ref('a', 'type-a', 'n1');
const to = ref('a', 'type-a', 'n2');
const lowerBound: Count = { value: 3, quality: 'lowerBound', scope: 'members' };
const AGGREGATE: GraphEdge = { ...edge('a', 'e1', 'n1', 'n2'), ref: { sourceId: 'a', aggregate: { type: 'SENT', from, to } }, type: 'SENT', memberCount: lowerBound };

function rig(members: Count) {
  const detail = { semantics: 'aggregate', members } as unknown as EdgeDetail;
  const client = fakeClient({ getEdge: async () => ({ ok: true, value: detail }) });
  const state = createClientState();
  state.bindSource('a');
  state.putResult(key('a'), { sourceId: 'a', nodes: [node('a', 'n1'), node('a', 'n2')], edges: [AGGREGATE] });
  state.setLoaded([key('a')], [from, to], [AGGREGATE.ref]);
  const reads = createEdgeReadStore(client, () => 'person', () => 'investigation');
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <ClientStateProvider state={state}>
      <EdgeReadProvider store={reads}>{children}</EdgeReadProvider>
    </ClientStateProvider>
  );
  return { reads, wrapper };
}

const countOf = (edges: readonly GraphEdge[]): Count | undefined => edges[0]?.memberCount;

describe('the graph drawn with the member counts the evidence panel read', () => {
  it('draws an exact count where the panel read exactly the lower bound, and leaves the loaded graph as it was', async () => {
    const { reads, wrapper } = rig({ value: 3, quality: 'exact', scope: 'members' });
    const { result } = renderHook(() => ({ drawn: useDisplayGraph(), loaded: useLoadedGraph() }), { wrapper });
    expect(countOf(result.current.drawn.edges)).toEqual(lowerBound);
    await act(async () => {
      reads.forEdge(AGGREGATE.ref, false).reload();
      await Promise.resolve();
    });
    expect(countOf(result.current.drawn.edges)).toMatchObject({ value: 3, quality: 'exact' });
    expect(countOf(result.current.loaded.edges)).toEqual(lowerBound);
  });

  it('draws no number where the panel read fewer members than the lower bound', async () => {
    const { reads, wrapper } = rig({ value: 2, quality: 'exact', scope: 'members' });
    const { result } = renderHook(() => useDisplayGraph(), { wrapper });
    await act(async () => {
      reads.forEdge(AGGREGATE.ref, false).reload();
      await Promise.resolve();
    });
    expect(countOf(result.current.edges)).toMatchObject({ quality: 'unknown' });
    expect(countOf(result.current.edges)?.value).toBeUndefined();
  });

  it('draws the count of the expansion again once the reads are dropped', async () => {
    const { reads, wrapper } = rig({ value: 3, quality: 'exact', scope: 'members' });
    const { result } = renderHook(() => useDisplayGraph(), { wrapper });
    await act(async () => {
      reads.forEdge(AGGREGATE.ref, false).reload();
      await Promise.resolve();
    });
    await act(async () => reads.clear());
    expect(countOf(result.current.edges)).toEqual(lowerBound);
  });
});
