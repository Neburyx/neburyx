import type { EdgeRef, GraphEdge } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { edge, edgeRef, key, node, ref } from '../state/test-data.js';
import { idsOfSelection } from './copy-ids.js';

const a = ref('a', 'type-a', 'n1');
const b = ref('a', 'type-a', 'n2');
const withRef = (id: string, edgeRef: EdgeRef, semantics: GraphEdge['semantics']): GraphEdge => ({ ...edge('a', id, 'n1', 'n2'), ref: edgeRef, semantics });

const stored = edge('a', 'e1', 'n1', 'n2');
const unknownOrigin = withRef('e2', edgeRef('a', 'e2'), 'unknown');
const aggregate = withRef('g', { sourceId: 'a', aggregate: { type: 'rel-a', from: a, to: b } }, 'stored');
const derived = withRef('d', { sourceId: 'a', derived: { ruleId: 'rule-1', from: a, to: b } }, 'derived');

function loaded(edges: readonly GraphEdge[]) {
  const state = createClientState();
  state.bindSource('a');
  state.putResult(key('a'), { sourceId: 'a', nodes: [node('a', 'n1'), node('a', 'n2')], edges: [...edges] });
  state.setLoaded([key('a')], [a, b], edges.map((item) => item.ref));
  return state.loadedGraph();
}

describe('the IDs of a selection', () => {
  it('are the stable IDs of the selected entities and of the relationships of the stored form (whatever their origin) in selection order, skipping and counting the aggregate and derived ones', () => {
    const graph = loaded([stored, unknownOrigin, aggregate, derived]);
    const selection = new Set([edgeKey(derived.ref), elementKey(b), edgeKey(unknownOrigin.ref), edgeKey(aggregate.ref), edgeKey(stored.ref), elementKey(a)]);
    expect(idsOfSelection(graph, selection)).toEqual({ ids: ['n2', 'e2', 'e1', 'n1'], withoutId: 2 });
  });

  it('are none for a selection of references that hold no ID, and an item that is not loaded is not counted', () => {
    const graph = loaded([aggregate, derived]);
    expect(idsOfSelection(graph, new Set([edgeKey(aggregate.ref), edgeKey(derived.ref)]))).toEqual({ ids: [], withoutId: 2 });
    expect(idsOfSelection(graph, new Set(['ghost']))).toEqual({ ids: [], withoutId: 0 });
  });
});
