import { createContext, useContext, type ReactNode } from 'react';
import type { MeResponse, SourcesResponse } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { createRequestStore } from '../api/request-store.js';
import type { RequestState } from '../api/use-request.js';
import { createStore, useStoreSelector, type ReadableStore } from '../state/store.js';

export interface ShellData {
  readonly me: RequestState<MeResponse>;
  readonly sources: RequestState<SourcesResponse>;
  /** Reads both again; the only way the shell asks twice. */
  readonly reload: () => void;
}

/** Reads the principal and the configured sources once, when it is created, outside React; every part of the shell reads these answers. */
export function createShellData(client: ApiClient): ReadableStore<ShellData> {
  const me = createRequestStore((signal) => client.getMe(signal));
  const sources = createRequestStore((signal) => client.getSources(signal));
  const reload = (): void => {
    me.reload();
    sources.reload();
  };
  const combine = (): ShellData => ({ me: me.getState(), sources: sources.getState(), reload });
  const store = createStore(combine());
  me.subscribe(() => store.setState(combine()));
  sources.subscribe(() => store.setState(combine()));
  return store;
}

const ShellDataContext = createContext<ReadableStore<ShellData> | undefined>(undefined);

export function ShellDataProvider({ store, children }: { readonly store: ReadableStore<ShellData>; readonly children: ReactNode }) {
  return <ShellDataContext.Provider value={store}>{children}</ShellDataContext.Provider>;
}

function useShellStore(): ReadableStore<ShellData> {
  const store = useContext(ShellDataContext);
  if (store === undefined) throw new Error('the shell data is not provided');
  return store;
}

export function useShellData(): ShellData {
  return useStoreSelector(useShellStore(), (data) => data);
}

export function answeredData<T>(state: RequestState<T>): T | undefined {
  return state.phase === 'ready' || state.phase === 'loading' ? state.data : undefined;
}

export function retainedFailure<T>(state: RequestState<T>) {
  return state.phase === 'failed' || state.phase === 'ready' ? state.failure : undefined;
}
