import { useMemo } from 'react';
import type { Count } from '@neburyx/contracts';
import { createStore, readable, useStoreSelector, type ReadableStore } from '../state/store.js';
import type { RequestState } from '../api/use-request.js';
import { useLoadedGraph, useSessionMask } from '../state/context.js';
import { partitionEdges, type LoadedGraph } from '../state/loaded-graph.js';
import { coverageEntitiesOf } from './coverage-input.js';
import { useCoverageStoreWhenProvided } from './coverage-context.js';
import { usePreviewAnswers } from './preview-context.js';
import { hiddenByFiltersLine, loadedLine, notDrawnLine, remainderLine, shownCount, UNKNOWN_REMAINDER } from './scope-text.js';

const NOTHING_ASKED: ReadableStore<RequestState<Count>> = readable(createStore<RequestState<Count>>({ phase: 'idle' }));

function useNotRetrieved(): Count {
  const graph = useLoadedGraph();
  const mask = useSessionMask();
  const coverage = useCoverageStoreWhenProvided();
  const previewAnswers = usePreviewAnswers();
  const entities = useMemo(() => coverageEntitiesOf(graph), [graph]);
  const [first] = graph.nodes;
  const request = coverage?.forGraph({ sourceId: first?.ref.sourceId, mask, previewAnswers, entities });
  const state = useStoreSelector(request ?? NOTHING_ASKED, (current) => current);
  return state.phase === 'ready' ? state.data : UNKNOWN_REMAINDER;
}

/** No filter or hide exists yet, so nothing is filtered out of what is loaded. */
const NOTHING_FILTERED = 0;

export function GraphScopeLines({ graph, filtered, notRetrieved }: { readonly graph: LoadedGraph; readonly filtered: number; readonly notRetrieved: Count }) {
  const parts = [loadedLine(graph), hiddenByFiltersLine(filtered, graph.nodes.length), notDrawnLine(partitionEdges(graph).notDrawable.length)].filter((part) => part !== undefined);
  return (
    <div className="graph-scope" role="group" aria-label="Graph scope">
      <p>{parts.join(' · ')}</p>
      <p>{remainderLine(shownCount(graph.nodes.length, filtered), notRetrieved)}</p>
    </div>
  );
}

export function GraphScope() {
  return <GraphScopeLines graph={useLoadedGraph()} filtered={NOTHING_FILTERED} notRetrieved={useNotRetrieved()} />;
}
