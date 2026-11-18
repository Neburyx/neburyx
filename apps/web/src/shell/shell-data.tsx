import { createContext, useContext, type ReactNode } from 'react';
import type { AiStatusResponse, MeResponse, SourcesResponse } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { createRequestStore } from '../api/request-store.js';
import type { RequestState } from '../api/use-request.js';
import { createStore, useStoreSelector, type ReadableStore } from '../state/store.js';

export interface ShellData {
  readonly me: RequestState<MeResponse>;
  readonly aiStatus: RequestState<AiStatusResponse>;
  readonly sources: RequestState<SourcesResponse>;
  readonly reload: () => void;
  readonly reloadSources: () => void;
}

/** Reads the principal and the configured sources once, when it is created, outside React; every part of the shell reads these answers. */
export function createShellData(client: ApiClient): ReadableStore<ShellData> {
  const me = createRequestStore((signal) => client.getMe(signal));
  const aiStatus = createRequestStore((signal) => client.getAiStatus(signal));
  const sources = createRequestStore((signal) => client.getSources(signal));
  const reload = (): void => {
    me.reload();
    aiStatus.reload();
    sources.reload();
  };
  const combine = (): ShellData => ({ me: me.getState(), aiStatus: aiStatus.getState(), sources: sources.getState(), reload, reloadSources: sources.reload });
  const store = createStore(combine());
  me.subscribe(() => store.setState(combine()));
  aiStatus.subscribe(() => store.setState(combine()));
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

export type AiFeature = 'ask' | 'summary' | 'assistant';

/** What the status of the AI features says of one feature: `pending` while the answer is not here, `unavailable` when it says no or the read failed, and on a page without shell data. */
export type AiAvailability = 'pending' | 'available' | 'unavailable';

function aiAvailabilityOf(data: ShellData | undefined, feature: AiFeature): AiAvailability {
  if (data === undefined) return 'unavailable';
  const status = answeredData(data.aiStatus);
  if (status === undefined) return retainedFailure(data.aiStatus) === undefined ? 'pending' : 'unavailable';
  return status[feature].available ? 'available' : 'unavailable';
}

export function useAiAvailabilityWhenProvided(feature: AiFeature): AiAvailability {
  const store = useContext(ShellDataContext);
  return useStoreSelector<ShellData | undefined, AiAvailability>(store ?? NO_ONE, (data) => aiAvailabilityOf(data, feature));
}

/** The words a message may hold, from the status of the AI features; nothing while the assistant is not available or the status is not here. */
export function useAssistantWordLimitWhenProvided(): number | undefined {
  const store = useContext(ShellDataContext);
  return useStoreSelector<ShellData | undefined, number | undefined>(store ?? NO_ONE, (data) => {
    const status = data === undefined ? undefined : answeredData(data.aiStatus);
    return status?.assistant.available === true ? status.assistant.messageWords : undefined;
  });
}

export function answeredData<T>(state: RequestState<T>): T | undefined {
  return state.phase === 'ready' || state.phase === 'loading' ? state.data : undefined;
}

export function retainedFailure<T>(state: RequestState<T>) {
  return state.phase === 'failed' || state.phase === 'ready' ? state.failure : undefined;
}
