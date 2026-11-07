import { createStore, type Store } from '../state/store.js';
import type { ApiFailure, ApiResult } from './client.js';
import { reduceRequest, UNEXPECTED, type RequestState } from './use-request.js';

export interface RequestStore<T> extends Store<RequestState<T>> {
  /** Asks again; an answer to an older ask is ignored. */
  readonly reload: () => void;
  /** Stops waiting: an answer still on its way is ignored and what was answered stays. */
  readonly cancel: () => void;
}

/**
 * A request that is made when the store is created and lives outside React, so rendering twice (StrictMode) never asks twice. `onFailure` is told of a failure that the store keeps,
 * never of one that a newer ask or a cancel made stale.
 */
export function createRequestStore<T>(load: (signal: AbortSignal) => Promise<ApiResult<T>>, onFailure?: (failure: ApiFailure, reload: () => void) => void): RequestStore<T> {
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
      if (!result.ok) onFailure?.(result.failure, reload);
    };
    void settle();
  };

  const cancel = (): void => {
    newest?.abort();
    newest = undefined;
    store.setState(reduceRequest(store.getState(), { type: 'cancel' }));
  };

  reload();
  return { ...store, reload, cancel };
}
