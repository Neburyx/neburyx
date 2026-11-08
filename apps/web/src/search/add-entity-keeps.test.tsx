import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { ExpandResponse, GraphNode } from '@neburyx/contracts';
import { createExpandStore } from '../api/expand-store.js';
import { fakeClient } from '../api/fake-client.js';
import { createClientState } from '../state/client-state.js';
import { edgeRef, node, ref } from '../state/test-data.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { ExpandProvider } from '../workspace/expand-context.js';
import { useAddEntity } from './use-add-entity.js';

const nodeOf = (type: string, id: string): GraphNode => ({ ...node('a', id), ref: ref('a', type, id), display: { title: id, type } });

describe('an entity asked for while an expansion puts it on the canvas', () => {
  it('stays when the expansion is collapsed', async () => {
    const anchor = ref('a', 'type-a', 'A');
    const b = nodeOf('kind-b', 'B');
    const c = nodeOf('kind-b', 'C');
    const expansion: ExpandResponse = {
      ref: anchor,
      pageSize: 25,
      nodes: [nodeOf('type-a', 'A'), b, c],
      edges: [b, c].map((to) => ({ ref: edgeRef('a', `A>${to.ref.stableId}`, 'link-a', 'type-a', 'kind-b'), from: anchor, to: to.ref, type: 'link-a', direction: 'out' as const, semantics: 'stored' as const, properties: [], evidenceRefs: [], qualityFlags: [] })),
      pages: [{ neighborType: 'kind-b', returned: 2, hasMore: false, matchingTotal: { value: 2, quality: 'exact', scope: 'x' } }],
      warnings: [],
    };
    let answerEntity: (() => void) | undefined;
    const client = fakeClient({
      expandNeighbors: () => Promise.resolve({ ok: true as const, value: expansion }),
      getEntity: () => new Promise((resolve) => void (answerEntity = () => resolve({ ok: true, value: b }))),
    });
    const state = createClientState();
    loadGraph(state, [nodeOf('type-a', 'A')], []);
    const store = createExpandStore(client, state, () => 'person');
    const wrapper = ({ children }: { children: ReactNode }) => <ExpandProvider store={store}>{children}</ExpandProvider>;
    const { result } = renderHook(() => useAddEntity(client, state, 'a', 'person', false), { wrapper });
    act(() => result.current.add(b));
    await act(async () => void (await store.expand(anchor, ['kind-b'])));
    await act(async () => answerEntity?.());
    store.collapse(anchor);
    expect(state.loadedGraph().nodes.map((held) => held.ref.stableId).sort()).toEqual(['A', 'B']);
  });
});
