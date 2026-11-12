import { useMemo } from 'react';
import { useEdgeReadStore } from '../evidence/edge-read.js';
import { useSessionMask, useVisibleGraph } from '../state/context.js';
import { readable, useStoreSelector, createStore } from '../state/store.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { withReadMemberCounts } from './read-member-counts.js';

const NO_ANSWERS = readable(createStore(0));

/** The visible graph with the member counts of the aggregates the evidence panel has read, for what is drawn and spoken about the aggregates; nothing is asked. */
export function useDisplayGraph(): LoadedGraph {
  const graph = useVisibleGraph();
  const reads = useEdgeReadStore();
  const mask = useSessionMask();
  const answers = useStoreSelector(reads?.answers ?? NO_ANSWERS, (count) => count);
  return useMemo(() => (reads === undefined ? graph : withReadMemberCounts(graph, (edge) => {
    const held = reads.held(edge.ref, mask);
    return held?.semantics === 'aggregate' ? held.members : undefined;
  })), [graph, reads, mask, answers]);
}
