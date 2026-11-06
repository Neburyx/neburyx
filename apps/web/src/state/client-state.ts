import type { EdgeRef, ElementRef } from '@neburyx/contracts';
import { StateError } from './errors.js';
import { createInvestigationStore, type InvestigationRecord, type InvestigationState, type LoadedInvestigation } from './investigation-state.js';
import { createJobStore, type JobState } from './job-state.js';
import { edgeKey, elementKey, type QueryKey } from './keys.js';
import { deriveLoadedGraph, type LoadedGraph } from './loaded-graph.js';
import { createPresentationStore, type PresentationActions, type PresentationSnapshot } from './presentation-state.js';
import { createServerStore, type GraphResult, type ServerState } from './server-state.js';
import { createStore, readable, type ReadableStore } from './store.js';

/** `current`: the investigation was already the one shown; `resumed`: it came back as it was left in this session; `fresh`: nothing was held of it. */
export type Activation = 'current' | 'resumed' | 'fresh';

export interface ClientState {
  readonly server: ReadableStore<ServerState> & { get(key: QueryKey): GraphResult | undefined };
  readonly investigation: ReadableStore<InvestigationState>;
  readonly presentation: PresentationActions;
  readonly jobs: ReadableStore<JobState>;
  /** Whether the session asks for the personal-data fields to be masked; every read of the session carries it. */
  readonly mask: ReadableStore<boolean>;
  setMask(mask: boolean): void;
  bindSource(sourceId: string): void;
  /** Whether the session holds the investigation as read for this mask, as the one shown or as one set aside. */
  holds(id: string, mask: boolean): boolean;
  /** Brings back an investigation the session holds as read for this mask, as it was left; the one shown is set aside whole. Nothing is read: results are kept, not dropped. Undefined when the session holds no such investigation, or holds it read for the other mask. */
  resume(id: string, mask: boolean): Exclude<Activation, 'fresh'> | undefined;
  /** Shows an investigation that is already read, all at once: the one shown is set aside, the result is stored under its key, and the investigation, its source and its graph change together. An investigation the session holds that was read for the same mask is shown as it was left and `loaded` is ignored; one read for the other mask is replaced. */
  show(loaded: LoadedInvestigation, results: readonly { readonly key: QueryKey; readonly result: GraphResult }[]): Activation;
  /** Sets what the header shows of the investigation, or clears it; refused while no source is bound. */
  describeInvestigation(record: InvestigationRecord | null): void;
  putResult(key: QueryKey, result: GraphResult): void;
  /** Replaces what the investigation holds with what the named results contain; selections, positions and pins of elements no longer held are dropped. */
  setLoaded(resultKeys: readonly QueryKey[], nodeRefs: readonly ElementRef[], edgeRefs: readonly EdgeRef[]): void;
  replacePins(keys: readonly string[]): void;
  loadedGraph(): LoadedGraph;
}

const readFor = (keys: readonly QueryKey[], mask: boolean): boolean => keys.every((key) => key.mask === mask);
const sameMask = (held: readonly QueryKey[], loaded: readonly QueryKey[]): boolean => held.every((key) => readFor(loaded, key.mask));

interface SetAside {
  readonly investigation: InvestigationState;
  readonly presentation: PresentationSnapshot;
}

export function createClientState(): ClientState {
  const server = createServerStore();
  const mask = createStore(false);
  const setAside = new Map<string, SetAside>();
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
    mask: readable(mask),
    setMask: (next) => mask.setState(next),
    bindSource(sourceId) {
      const previous = investigation.view.getState().sourceId;
      if (previous === sourceId) return;
      if (previous !== null) {
        server.dropSource(previous);
        // the results of an investigation set aside went with them, so it is read again rather than shown empty
        for (const [id, held] of setAside) if (held.investigation.sourceId === previous) setAside.delete(id);
      }
      presentation.reset();
      investigation.bind(sourceId);
    },
    holds(id, mask) {
      const shown = investigation.view.getState();
      if (shown.id === id) return readFor(shown.resultKeys, mask);
      const held = setAside.get(id);
      return held !== undefined && readFor(held.investigation.resultKeys, mask);
    },
    resume(id, mask) {
      const shown = investigation.view.getState();
      if (shown.id === id) return readFor(shown.resultKeys, mask) ? 'current' : undefined;
      const held = setAside.get(id);
      if (held === undefined || !readFor(held.investigation.resultKeys, mask)) return undefined;
      if (shown.id !== null) setAside.set(shown.id, { investigation: shown, presentation: presentation.snapshot() });
      setAside.delete(id);
      investigation.restore(held.investigation);
      presentation.restore(held.presentation);
      return 'resumed';
    },
    show(loaded, results) {
      const shown = investigation.view.getState();
      if (shown.id === loaded.id && sameMask(shown.resultKeys, loaded.resultKeys)) return 'current';
      for (const { key, result } of results) {
        if (key.sourceId !== loaded.sourceId || result.sourceId !== loaded.sourceId) throw new StateError('SOURCE_MISMATCH');
      }
      const aside = setAside.get(loaded.id);
      const held = aside !== undefined && sameMask(aside.investigation.resultKeys, loaded.resultKeys) ? aside : undefined;
      if (held === undefined) {
        // checks the sources named by the investigation before anything is stored or set aside
        const probe = createInvestigationStore();
        probe.load(loaded);
        for (const { key, result } of results) server.put(key, result);
      }
      if (shown.id !== null && shown.id !== loaded.id) setAside.set(shown.id, { investigation: shown, presentation: presentation.snapshot() });
      setAside.delete(loaded.id);
      if (held !== undefined) {
        investigation.restore(held.investigation);
        presentation.restore(held.presentation);
        return 'resumed';
      }
      investigation.load(loaded);
      presentation.reset();
      return 'fresh';
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
