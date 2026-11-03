import { useSyncExternalStore } from 'react';

export interface ReadableStore<S> {
  getState(): S;
  subscribe(listener: () => void): () => void;
}

export interface Store<S> extends ReadableStore<S> {
  setState(next: S): void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState(next) {
      if (Object.is(next, state)) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function readable<S>(store: ReadableStore<S>): ReadableStore<S> {
  return { getState: store.getState, subscribe: store.subscribe };
}

/** The selector must return a value that is the same object while the part of the state it reads is unchanged. */
export function useStoreSelector<S, T>(store: ReadableStore<S>, selector: (state: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}
