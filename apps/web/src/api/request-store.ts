import { createStore, type Store } from '../state/store.js';
import type { ApiResult } from './client.js';
import { reduceRequest, UNEXPECTED, type RequestState } from './use-request.js';

export interface RequestStore<T> extends Store<RequestState<T>> {
  /** Asks again; an answer to an older ask is ignored. */
  readonly reload: () => void;
}

/** A request that is made when the store is created and lives outside React, so rendering twice (StrictMode) never asks twice. */
export function createRequestStore<T>(load: (signal: AbortSignal) => Promise<ApiResult<T>>): RequestStore<T> {
  const store = createStore<RequestState<T>>({ phase: 'idle' });
  let newest: AbortController | undefined;

  const reload = (): void => {
    newest?.abort();
    const controller = new AbortController();
    newest = controller;
    store.setState(reduceRequest(store.getState(), { type: 'start' }));
    const settle = async (): Promise<void> => {
      let result: ApiResult<T>;
      try {
        result = await load(controller.signal);
      } catch {
        result = UNEXPECTED;
      }
      if (newest !== controller) return;
      if (!result.ok && result.failure.code === 'ABORTED') return;
      store.setState(reduceRequest(store.getState(), { type: 'answer', result }));
    };
    void settle();
  };

  reload();
  return { ...store, reload };
}
