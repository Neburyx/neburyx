import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { edgeRefSegmentOf, type EdgeDetail, type EdgeReadRef } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { createRequestStore, type RequestStore } from '../api/request-store.js';
import type { RequestState } from '../api/use-request.js';
import type { ClientState } from '../state/client-state.js';
import { createStore, readable, useStoreSelector } from '../state/store.js';

export interface EdgeReadStore {
  /** The read of a stored edge under a masking setting in the investigation that asked: made once and kept; ask again with its `reload`. */
  forEdge(ref: EdgeReadRef, mask: boolean): RequestStore<EdgeDetail>;
  /** Says one more part of the panel wants the read; the function it returns says that part is gone. The read in flight is cancelled only when no part wants it any more. */
  hold(ref: EdgeReadRef, mask: boolean): () => void;
  /** Cancels every read in flight and drops every held read. */
  clear(): void;
}

const keyOf = (person: string, investigation: string, ref: EdgeReadRef, mask: boolean): string => JSON.stringify([person, investigation, edgeRefSegmentOf(ref), mask]);

/** The edge reads of a person's session, each under the person, investigation, reference and masking setting that asked, so an answer for one edge is never shown for another. The Search page, which has no investigation, passes an empty one. */
export function createEdgeReadStore(client: ApiClient, person: () => string, investigation: () => string): EdgeReadStore {
  const requests = new Map<string, RequestStore<EdgeDetail>>();
  const holds = new Map<string, number>();
  const forEdge: EdgeReadStore['forEdge'] = (ref, mask) => {
    const key = keyOf(person(), investigation(), ref, mask);
    const held = requests.get(key);
    if (held !== undefined) return held;
    const request = createRequestStore((signal) => client.getEdge(ref, mask ? { mask } : {}, signal));
    requests.set(key, request);
    return request;
  };
  return {
    forEdge,
    hold(ref, mask) {
      const key = keyOf(person(), investigation(), ref, mask);
      holds.set(key, (holds.get(key) ?? 0) + 1);
      return () => {
        const left = (holds.get(key) ?? 1) - 1;
        holds.set(key, left);
        const request = requests.get(key);
        if (left <= 0 && request?.getState().phase === 'loading') request.cancel();
      };
    },
    clear() {
      for (const request of requests.values()) if (request.getState().phase === 'loading') request.cancel();
      requests.clear();
      holds.clear();
    },
  };
}

/** Drops the held reads when the investigation shown or the masking changes, and only then: a load, an expansion or a hide changes the investigation's graph and leaves a read of an edge valid. */
export function dropReadsOnNewEpoch(state: ClientState, reads: EdgeReadStore): () => void {
  const epochOf = (): string => JSON.stringify([state.investigation.getState().id, state.mask.getState()]);
  let epoch = epochOf();
  const check = (): void => {
    const now = epochOf();
    if (now === epoch) return;
    epoch = now;
    reads.clear();
  };
  const unsubscribes = [state.investigation.subscribe(check), state.mask.subscribe(check)];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

const EdgeReadContext = createContext<EdgeReadStore | undefined>(undefined);

export function EdgeReadProvider({ store, children }: { readonly store: EdgeReadStore; readonly children: ReactNode }) {
  return <EdgeReadContext.Provider value={store}>{children}</EdgeReadContext.Provider>;
}

const NO_READ = readable(createStore<RequestState<EdgeDetail>>({ phase: 'idle' }));

export interface EdgeRead {
  /** The answer, kept while a later ask is on its way. */
  readonly detail: EdgeDetail | undefined;
  /** What the last ask ended with when it failed; it stays while the next ask is on its way. */
  readonly failure: ApiFailure | undefined;
  readonly reading: boolean;
  readonly reload: () => void;
}

const DO_NOTHING = (): void => undefined;

/** The read of the edge the panel shows. It is asked for while the panel shows the edge and an ask in flight is cancelled when the panel moves on; with no store provided it never asks. */
export function useEdgeRead(ref: EdgeReadRef, mask: boolean): EdgeRead {
  const store = useContext(EdgeReadContext);
  const request = store?.forEdge(ref, mask);
  const state = useStoreSelector(request ?? NO_READ, (current) => current);
  const [kept, setKept] = useState<{ readonly request: RequestStore<EdgeDetail> | undefined; readonly failure: ApiFailure | undefined }>({ request, failure: undefined });
  const failure = state.phase === 'failed' || state.phase === 'ready' ? state.failure : undefined;
  useEffect(() => {
    if (state.phase === 'failed' || state.phase === 'ready') setKept({ request, failure });
  }, [state.phase, failure, request]);
  useEffect(() => {
    if (store === undefined || request === undefined) return undefined;
    if (request.getState().phase === 'idle') request.reload();
    return store.hold(ref, mask);
  }, [store, request, ref, mask]);
  const reading = state.phase === 'loading' || state.phase === 'idle';
  const shown = reading && kept.request === request ? kept.failure : failure;
  return { detail: state.phase === 'ready' || state.phase === 'loading' ? state.data : undefined, failure: shown, reading, reload: request?.reload ?? DO_NOTHING };
}
