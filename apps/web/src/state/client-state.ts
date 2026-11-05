import type { EdgeRef, ElementRef } from '@neburyx/contracts';
import { StateError } from './errors.js';
import { createInvestigationStore, type InvestigationRecord, type InvestigationState } from './investigation-state.js';
import { createJobStore, type JobState } from './job-state.js';
import { edgeKey, elementKey, type QueryKey } from './keys.js';
import { deriveLoadedGraph, type LoadedGraph } from './loaded-graph.js';
import { createPresentationStore, type PresentationActions } from './presentation-state.js';
import { createServerStore, type GraphResult, type ServerState } from './server-state.js';
import type { ReadableStore } from './store.js';

export interface ClientState {
  readonly server: ReadableStore<ServerState> & { get(key: QueryKey): GraphResult | undefined };
  readonly investigation: ReadableStore<InvestigationState>;
  readonly presentation: PresentationActions;
  readonly jobs: ReadableStore<JobState>;
  bindSource(sourceId: string): void;
  /** Sets what the header shows of the investigation, or clears it; refused while no source is bound. */
  describeInvestigation(record: InvestigationRecord | null): void;
  putResult(key: QueryKey, result: GraphResult): void;
  /** Replaces what the investigation holds with what the named results contain; selections, positions and pins of elements no longer held are dropped. */
  setLoaded(resultKeys: readonly QueryKey[], nodeRefs: readonly ElementRef[], edgeRefs: readonly EdgeRef[]): void;
  replacePins(keys: readonly string[]): void;
  loadedGraph(): LoadedGraph;
}

export function createClientState(): ClientState {
  const server = createServerStore();
  const investigation = createInvestigationStore();
  const nodeKeySets = new WeakMap<InvestigationState, ReadonlySet<string>>();
  const edgeKeySets = new WeakMap<InvestigationState, ReadonlySet<string>>();
  const nodeKeys = (): ReadonlySet<string> => {
    const held = investigation.view.getState();
    const known = nodeKeySets.get(held) ?? new Set(held.nodeRefs.map(elementKey));
    nodeKeySets.set(held, known);
    return known;
  };
  const edgeKeys = (): ReadonlySet<string> => {
    const held = investigation.view.getState();
    const known = edgeKeySets.get(held) ?? new Set(held.edgeRefs.map(edgeKey));
    edgeKeySets.set(held, known);
    return known;
  };
  const presentation = createPresentationStore({
    isNode: (key) => nodeKeys().has(key),
    isElement: (key) => nodeKeys().has(key) || edgeKeys().has(key),
  });
  const { view, setTool, setOpenTool, setOpenMenu, select, setPosition, setPositions, pin, setPanelSize, clearPanelSize, setPanelCollapsed, clearPanelCollapsed, setLegendOpen, setSheetOpen, walkTo, endWalk, forgetFocused, announceMove, setViewport } = presentation;
  return {
    server: { ...server.view, get: server.get },
    investigation: investigation.view,
    presentation: { view, setTool, setOpenTool, setOpenMenu, select, setPosition, setPositions, pin, setPanelSize, clearPanelSize, setPanelCollapsed, clearPanelCollapsed, setLegendOpen, setSheetOpen, walkTo, endWalk, forgetFocused, announceMove, setViewport },
    jobs: createJobStore(),
    bindSource(sourceId) {
      const previous = investigation.view.getState().sourceId;
      if (previous === sourceId) return;
      if (previous !== null) server.dropSource(previous);
      presentation.reset();
      investigation.bind(sourceId);
    },
    describeInvestigation: (record) => investigation.describe(record),
    putResult(key, result) {
      const bound = investigation.view.getState().sourceId;
      if (bound === null) throw new StateError('NO_SOURCE_BOUND');
      if (key.sourceId !== bound || result.sourceId !== bound) throw new StateError('SOURCE_MISMATCH');
      server.put(key, result);
    },
    setLoaded(resultKeys, nodeRefs, edgeRefs) {
      investigation.setLoaded(resultKeys, nodeRefs, edgeRefs);
      presentation.prune();
    },
    replacePins: (keys) => presentation.replacePins(keys),
    loadedGraph: () => deriveLoadedGraph(server.view.getState(), investigation.view.getState()),
  };
}
