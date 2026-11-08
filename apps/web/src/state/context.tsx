import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ClientState } from './client-state.js';
import { deriveLoadedGraph, excludedKeys, filteredKeys, visibleGraph, withoutRelationshipTypes, type LoadedGraph } from './loaded-graph.js';
import { useStoreSelector } from './store.js';

const ClientStateContext = createContext<ClientState | undefined>(undefined);

export function ClientStateProvider({ state, children }: { readonly state: ClientState; readonly children: ReactNode }) {
  return <ClientStateContext.Provider value={state}>{children}</ClientStateContext.Provider>;
}

export function useClientState(): ClientState {
  const state = useContext(ClientStateContext);
  if (state === undefined) throw new Error('the client state is not provided');
  return state;
}

/** The state when one is provided, and nothing in a part of the app drawn without it. */
export function useClientStateWhenProvided(): ClientState | undefined {
  return useContext(ClientStateContext);
}

/** Whether the session asks for the personal-data fields to be masked. */
export function useSessionMask(): boolean {
  return useStoreSelector(useClientState().mask, (mask) => mask);
}

export function useLoadedGraph(): LoadedGraph {
  const state = useClientState();
  const server = useStoreSelector(state.server, (current) => current);
  const investigation = useStoreSelector(state.investigation, (current) => current);
  return useMemo(() => deriveLoadedGraph(server, investigation), [server, investigation]);
}

/** The loaded graph without the entities hidden from the view, and the relationships that touch them. */
export function useVisibleGraph(): LoadedGraph {
  const state = useClientState();
  const graph = useLoadedGraph();
  const excluded = useExcludedKeys(graph);
  const offRelationshipTypes = useStoreSelector(state.presentation.view, (current) => current.typeFilter.offRelationshipTypes);
  return useMemo(() => withoutRelationshipTypes(visibleGraph(graph, excluded), offRelationshipTypes), [graph, excluded, offRelationshipTypes]);
}

/** The entities of the loaded graph that are left out of the view, by hand or by a filter. */
export function useExcludedKeys(graph: LoadedGraph): ReadonlySet<string> {
  const state = useClientState();
  const hidden = useStoreSelector(state.presentation.view, (current) => current.hidden);
  const neighborhoodFocus = useStoreSelector(state.presentation.view, (current) => current.neighborhoodFocus);
  const typeFilter = useStoreSelector(state.presentation.view, (current) => current.typeFilter);
  return useMemo(() => excludedKeys(graph, { hidden, neighborhoodFocus, filtered: filteredKeys(graph, typeFilter) }), [graph, hidden, neighborhoodFocus, typeFilter]);
}
