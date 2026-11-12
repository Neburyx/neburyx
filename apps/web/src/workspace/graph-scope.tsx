import { Fragment, useMemo, type ReactNode } from 'react';
import type { Count } from '@neburyx/contracts';
import type { NotRetrieved } from '../api/coverage-store.js';
import { createStore, readable, useStoreSelector, type ReadableStore } from '../state/store.js';
import type { RequestState } from '../api/use-request.js';
import { useClientState, useLoadedGraph, useSessionMask } from '../state/context.js';
import { elementKey } from '../state/keys.js';
import { neighborhoodOf, outsideFocusKeys, filteredKeys, partitionEdges, type LoadedGraph } from '../state/loaded-graph.js';
import { coverageEntitiesOf } from './coverage-input.js';
import { useCoverageStoreWhenProvided } from './coverage-context.js';
import { usePreviewAnswers } from './preview-context.js';
import { showHiddenAndFocusCanvas } from '../canvas/hide-commands.js';
import { leaveFocusAndFocusCanvas } from '../canvas/focus-commands.js';
import { isSourceChanged } from '../state/investigation-state.js';
import { filteredOnlyCount, hiddenByFiltersLine, hiddenFromViewLine, outsideFocusLine, formatNumber, loadedLine, notDrawnLine, remainderLine, savedLayoutLine, savedLayoutShownLine, shownCount, UNKNOWN_REMAINDER } from './scope-text.js';

const NOTHING_ASKED: ReadableStore<RequestState<NotRetrieved>> = readable(createStore<RequestState<NotRetrieved>>({ phase: 'idle' }));

/** What is not yet retrieved of the loaded graph, as the graph scope lines show it. */
export function useNotRetrieved(): NotRetrieved {
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

const NO_KEYS: ReadonlySet<string> = new Set();

export function GraphScopeLines({ graph, hidden, filtered, outside = NO_KEYS, onLeaveFocus, notRetrieved, onShowHidden, savedLayout = false }: { readonly savedLayout?: boolean; readonly graph: LoadedGraph; readonly hidden: ReadonlySet<string>; readonly filtered: ReadonlySet<string>; readonly outside?: ReadonlySet<string>; readonly onLeaveFocus?: () => void; readonly notRetrieved: NotRetrieved; readonly onShowHidden?: () => void }) {
  const loaded = graph.nodes.map((node) => elementKey(node.ref));
  const hiddenCount = loaded.filter((key) => hidden.has(key)).length;
  const show =
    hiddenCount === 0 || onShowHidden === undefined ? null : (
      <button type="button" className="graph-scope-show" aria-label={`Show ${formatNumber(hiddenCount)} hidden ${hiddenCount === 1 ? 'entity' : 'entities'}`} onClick={onShowHidden}>
        Show {formatNumber(hiddenCount)}
      </button>
    );
  const parts: ReactNode[] = [
    savedLayout ? savedLayoutLine(graph) : loadedLine(graph),
    hiddenFromViewLine(hiddenCount) === undefined ? undefined : (
      <Fragment key="hidden">
        {hiddenFromViewLine(hiddenCount)}
        {show === null ? null : <> · {show}</>}
      </Fragment>
    ),
    onLeaveFocus === undefined ? undefined : (
      <Fragment key="focus">
        {outsideFocusLine(outside.size)} ·{' '}
        <button type="button" className="graph-scope-show" onClick={onLeaveFocus}>
          Leave focus
        </button>
      </Fragment>
    ),
    hiddenByFiltersLine(filteredOnlyCount(loaded, hidden, filtered, outside)),
    notDrawnLine(partitionEdges(graph).notDrawable.length),
  ].filter((part) => part !== undefined);
  return (
    <div className="graph-scope" role="group" aria-label="Graph scope">
      <p>
        {parts.flatMap((part, at) => (at === 0 ? [part] : [' · ', part]))}
      </p>
      <p>{savedLayout ? savedLayoutShownLine(shownCount(loaded, hidden, filtered, outside)) : remainderLine(shownCount(loaded, hidden, filtered, outside), notRetrieved)}</p>
    </div>
  );
}

export function GraphScope() {
  const state = useClientState();
  const hidden = useStoreSelector(state.presentation.view, (current) => current.hidden);
  const neighborhoodFocus = useStoreSelector(state.presentation.view, (current) => current.neighborhoodFocus);
  const typeFilter = useStoreSelector(state.presentation.view, (current) => current.typeFilter);
  const graph = useLoadedGraph();
  const savedLayout = useStoreSelector(state.investigation, (held) => isSourceChanged(held.record?.sourceState));
  const focusing = neighborhoodFocus !== undefined && neighborhoodOf(graph, neighborhoodFocus).size > 0;
  const outside = useMemo(() => outsideFocusKeys(graph, neighborhoodFocus, hidden), [graph, neighborhoodFocus, hidden]);
  const filtered = useMemo(() => filteredKeys(graph, typeFilter), [graph, typeFilter]);
  return <GraphScopeLines savedLayout={savedLayout} graph={graph} hidden={hidden} filtered={filtered} outside={outside} notRetrieved={useNotRetrieved()} onShowHidden={() => showHiddenAndFocusCanvas(state)} onLeaveFocus={focusing ? () => leaveFocusAndFocusCanvas(state) : undefined} />;
}
