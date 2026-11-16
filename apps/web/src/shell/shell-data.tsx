import { createContext, useContext, type ReactNode } from 'react';
import type { MeResponse, SourcesResponse } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { createRequestStore } from '../api/request-store.js';
import type { RequestState } from '../api/use-request.js';
import { createStore, useStoreSelector, type ReadableStore } from '../state/store.js';

export interface ShellData {
  readonly me: RequestState<MeResponse>;
  readonly sources: RequestState<SourcesResponse>;
  readonly reload: () => void;
  readonly reloadSources: () => void;
}

/** Reads the principal and the configured sources once, when it is created, outside React; every part of the shell reads these answers. */
export function createShellData(client: ApiClient): ReadableStore<ShellData> {
  const me = createRequestStore((signal) => client.getMe(signal));
  const sources = createRequestStore((signal) => client.getSources(signal));
  const reload = (): void => {
    me.reload();
    sources.reload();
  };
  const combine = (): ShellData => ({ me: me.getState(), sources: sources.getState(), reload, reloadSources: sources.reload });
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

const NO_ONE: ReadableStore<undefined> = { getState: () => undefined, subscribe: () => () => undefined };

/** The signed-in person's ID when the shell data is provided, and nothing in a part of the app drawn without it (a test of one tool). */
export function usePrincipalIdWhenProvided(): string | undefined {
  const store = useContext(ShellDataContext);
  const principal = useStoreSelector<ShellData | undefined, string | undefined>(store ?? NO_ONE, (data) => (data === undefined ? undefined : answeredData(data.me)?.principal.id));
  return principal;
}

/** Whether `GET /v1/me` says the edition is enterprise; false while that answer is not here and on a page without shell data. */
export function useEnterpriseWhenProvided(): boolean {
  const store = useContext(ShellDataContext);
  return useStoreSelector<ShellData | undefined, boolean>(store ?? NO_ONE, (data) => (data === undefined ? false : answeredData(data.me)?.edition === 'enterprise'));
}

export function answeredData<T>(state: RequestState<T>): T | undefined {
  return state.phase === 'ready' || state.phase === 'loading' ? state.data : undefined;
}

export function retainedFailure<T>(state: RequestState<T>) {
  return state.phase === 'failed' || state.phase === 'ready' ? state.failure : undefined;
}
