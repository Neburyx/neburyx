import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ClientState } from './client-state.js';
import { deriveLoadedGraph, type LoadedGraph } from './loaded-graph.js';
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

export function useLoadedGraph(): LoadedGraph {
  const state = useClientState();
  const server = useStoreSelector(state.server, (current) => current);
  const investigation = useStoreSelector(state.investigation, (current) => current);
  return useMemo(() => deriveLoadedGraph(server, investigation), [server, investigation]);
}
