import type { EdgeRef, ElementRef } from '@neburyx/contracts';
import { StateError } from './errors.js';
import { createInvestigationStore, type InvestigationRecord, type InvestigationState, type LoadedInvestigation } from './investigation-state.js';
import { createJobStore, type JobState } from './job-state.js';
import { edgeKey, elementKey, type QueryKey } from './keys.js';
import { deriveLoadedGraph, excludedKeys, filteredKeys, neighborhoodOf, visibleGraph, withoutRelationshipTypes, type LoadedGraph } from './loaded-graph.js';
import { createPresentationStore, type PresentationActions, type PresentationSnapshot, type Viewport } from './presentation-state.js';
import { createServerStore, type GraphResult, type ServerState } from './server-state.js';
import { createStore, readable, type ReadableStore } from './store.js';

/** `current`: the investigation was already the one shown; `resumed`: it came back as it was left in this session; `fresh`: nothing was held of it. */
export type Activation = 'current' | 'resumed' | 'fresh';

export interface ClientState {
  readonly server: ReadableStore<ServerState> & { get(key: QueryKey): GraphResult | undefined };
  readonly investigation: ReadableStore<InvestigationState>;
  /** Hiding goes through `hide` of the state, which also takes the relationships of the hidden entities out of the selection. */
  readonly presentation: Omit<PresentationActions, 'hide' | 'focusOn' | 'setEntityTypeOff' | 'setRelationshipTypeOff'>;
  readonly jobs: ReadableStore<JobState>;
  /** Whether the session asks for the personal-data fields to be masked; every read of the session carries it. */
  readonly mask: ReadableStore<boolean>;
  setMask(mask: boolean): void;
  bindSource(sourceId: string): void;
  /** Returns to no source bound, but only when nothing is shown: no investigation and no loaded entity or relationship. It drops the source's results as `bindSource` does unless an investigation that is set aside still holds the source. */
  unbindSource(): void;
  /** Whether the session holds the investigation as read for this mask, as the one shown or as one set aside. */
  holds(id: string, mask: boolean): boolean;
  /** Brings back an investigation the session holds as read for this mask, as it was left; the one shown is set aside whole. Nothing is read: results are kept, not dropped. Undefined when the session holds no such investigation, or holds it read for the other mask. */
  resume(id: string, mask: boolean): Exclude<Activation, 'fresh'> | undefined;
  /** Shows an investigation that is already read, all at once: the one shown is set aside, the result is stored under its key, and the investigation, its source and its graph change together. An investigation the session holds that was read for the same mask is shown as it was left and `loaded` is ignored; one read for the other mask is replaced. */
  show(loaded: LoadedInvestigation, results: readonly { readonly key: QueryKey; readonly result: GraphResult }[]): Activation;
  /** Replaces the graph and the presentation of the investigation shown with an investigation of the same ID that is already read, all at once: nothing of the old graph or of its positions, pins, hidden items and filters is kept. Refused when anything named belongs to another source. */
  replace(loaded: LoadedInvestigation, results: readonly { readonly key: QueryKey; readonly result: GraphResult }[]): void;
  /** Drops an investigation the session holds, the one shown as well, so that opening it again reads it anew; when it is the one shown, nothing is shown afterwards. */
  forget(id: string): void;
  /** Sets what the header shows of the investigation, or clears it; refused while no source is bound. */
  describeInvestigation(record: InvestigationRecord | null): void;
  putResult(key: QueryKey, result: GraphResult): void;
  /** Replaces what the investigation holds with what the named results contain; selections, positions and pins of elements no longer held are dropped. */
  setLoaded(resultKeys: readonly QueryKey[], nodeRefs: readonly ElementRef[], edgeRefs: readonly EdgeRef[]): void;
  replacePins(keys: readonly string[]): void;
  loadedGraph(): LoadedGraph;
  /** What is drawn of the loaded graph: without the hidden entities and the relationships that touch them. */
  visibleGraph(): LoadedGraph;
  /** Hides entities; the selected relationships that touch them leave the selection with them. */
  hide(keys: readonly string[]): void;
  /** Puts the neighborhood focus on an entity; refused with `UNKNOWN_ELEMENT` for a key that is not a loaded, shown entity. Runs no source read. */
  focusOn(key: string, viewport?: Viewport): void;
  /** Switches an entity type off or on; the selected relationships that touch an entity of an off type leave the selection with it. */
  setEntityTypeOff(type: string, off: boolean): void;
  /** Switches a relationship type off or on; the loaded relationships of the type leave the selection with it. */
  setRelationshipTypeOff(type: string, off: boolean): void;
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
  const { view, setTool, setOpenTool, setOpenMenu, select, setLayout, setLayoutDirection, setPhysics, applyLayout, setPosition, setPositions, pin, unpin, setPanelSize, clearPanelSize, setPanelCollapsed, clearPanelCollapsed, setLegendOpen, setSearchOpen, setSearchTab, requestSearch, setSheetOpen, setSupernodePanel, setSceneItems, walkTo, endWalk, forgetFocused, announceMove, setViewport, showAllHidden, showHidden, leaveFocus, setMappedTypes, resetTypeFilter, setFiltersOpen, setPatternsOpen, setPatternsPreset } = presentation;
  return {
    server: { ...server.view, get: server.get },
    investigation: investigation.view,
    presentation: { view, setTool, setOpenTool, setOpenMenu, select, setLayout, setLayoutDirection, setPhysics, applyLayout, setPosition, setPositions, pin, unpin, setPanelSize, clearPanelSize, setPanelCollapsed, clearPanelCollapsed, setLegendOpen, setSearchOpen, setSearchTab, requestSearch, setSheetOpen, setSupernodePanel, setSceneItems, walkTo, endWalk, forgetFocused, announceMove, setViewport, showAllHidden, showHidden, leaveFocus, setMappedTypes, resetTypeFilter, setFiltersOpen, setPatternsOpen, setPatternsPreset },
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
    unbindSource() {
      const shown = investigation.view.getState();
      if (shown.sourceId === null || shown.id !== null || shown.nodeRefs.length > 0 || shown.edgeRefs.length > 0) return;
      const keptSource = [...setAside.values()].some((held) => held.investigation.sourceId === shown.sourceId);
      if (!keptSource) server.dropSource(shown.sourceId);
      presentation.reset();
      presentation.setPatternsOpen(false);
      investigation.restore({ id: null, sourceId: null, record: null, resultKeys: [], nodeRefs: [], edgeRefs: [] });
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
    replace(loaded, results) {
      if (investigation.view.getState().id !== loaded.id) throw new StateError('SOURCE_MISMATCH');
      for (const { key, result } of results) {
        if (key.sourceId !== loaded.sourceId || result.sourceId !== loaded.sourceId) throw new StateError('SOURCE_MISMATCH');
      }
      // checks the sources named by the investigation before anything is stored
      createInvestigationStore().load(loaded);
      for (const { key, result } of results) server.put(key, result);
      investigation.load(loaded);
      presentation.reset();
    },
    forget(id) {
      const shown = investigation.view.getState();
      if (shown.id !== id) {
        setAside.delete(id);
        return;
      }
      investigation.restore({ id: null, sourceId: shown.sourceId, record: null, resultKeys: [], nodeRefs: [], edgeRefs: [] });
      presentation.reset();
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
    visibleGraph: () => {
      const { hidden, neighborhoodFocus, typeFilter } = presentation.view.getState();
      const graph = deriveLoadedGraph(server.view.getState(), investigation.view.getState());
      return withoutRelationshipTypes(visibleGraph(graph, excludedKeys(graph, { hidden, neighborhoodFocus, filtered: filteredKeys(graph, typeFilter) })), typeFilter.offRelationshipTypes);
    },
    focusOn(key, viewport) {
      const graph = deriveLoadedGraph(server.view.getState(), investigation.view.getState());
      const near = neighborhoodOf(graph, key);
      const goneNodes = new Set(graph.nodes.map((node) => elementKey(node.ref)).filter((candidate) => !near.has(candidate)));
      const goneEdges = graph.edges.filter((edge) => goneNodes.has(elementKey(edge.from)) || goneNodes.has(elementKey(edge.to))).map((edge) => edgeKey(edge.ref));
      presentation.focusOn(key, [...goneNodes, ...goneEdges], viewport);
    },
    setRelationshipTypeOff(type, off) {
      const graph = deriveLoadedGraph(server.view.getState(), investigation.view.getState());
      presentation.setRelationshipTypeOff(type, off, graph.edges.filter((edge) => edge.type === type).map((edge) => edgeKey(edge.ref)));
    },
    setEntityTypeOff(type, off) {
      const graph = deriveLoadedGraph(server.view.getState(), investigation.view.getState());
      const ofType = new Set(graph.nodes.filter((node) => node.ref.entityType === type).map((node) => elementKey(node.ref)));
      presentation.setEntityTypeOff(type, off, graph.edges.filter((edge) => ofType.has(elementKey(edge.from)) || ofType.has(elementKey(edge.to))).map((edge) => edgeKey(edge.ref)));
    },
    hide(keys) {
      const hiding = new Set(keys);
      const touching = deriveLoadedGraph(server.view.getState(), investigation.view.getState()).edges.filter((edge) => hiding.has(elementKey(edge.from)) || hiding.has(elementKey(edge.to))).map((edge) => edgeKey(edge.ref));
      presentation.hide(keys, touching);
    },
  };
}
