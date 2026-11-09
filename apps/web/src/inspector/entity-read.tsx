import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { ElementRef, GraphNode } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { createRequestStore, type RequestStore } from '../api/request-store.js';
import type { RequestState } from '../api/use-request.js';
import { createStore, readable, useStoreSelector } from '../state/store.js';

export interface EntityRead {
  readonly phase: 'idle' | 'loading' | 'ready' | 'failed';
  /** What the read answered with, kept while a later ask is on its way or failed. */
  readonly node?: GraphNode;
  readonly failure?: ApiFailure;
  readonly reload: () => void;
}

export interface EntityReadStore {
  /** The read of an entity under a masking setting in the investigation that asked: made once and kept; ask again with its `reload`. */
  forEntity(ref: ElementRef, mask: boolean): RequestStore<GraphNode>;
}

const keyOf = (person: string, investigation: string, ref: ElementRef, mask: boolean): string => JSON.stringify([person, investigation, ref.sourceId, ref.entityType, ref.stableId, mask]);

/** The entity reads of a person's session, each under the person, investigation, entity and masking setting that asked, so an answer for one entity is never shown for another. */
export function createEntityReadStore(client: ApiClient, person: () => string, investigation: () => string): EntityReadStore {
  const requests = new Map<string, RequestStore<GraphNode>>();
  return {
    forEntity(ref, mask) {
      const key = keyOf(person(), investigation(), ref, mask);
      const held = requests.get(key);
      if (held !== undefined) return held;
      const request = createRequestStore((signal) => client.getEntity(ref, mask ? { mask } : {}, signal));
      requests.set(key, request);
      return request;
    },
  };
}

const EntityReadContext = createContext<EntityReadStore | undefined>(undefined);

export function EntityReadProvider({ store, children }: { readonly store: EntityReadStore; readonly children: ReactNode }) {
  return <EntityReadContext.Provider value={store}>{children}</EntityReadContext.Provider>;
}

const NO_READ = readable(createStore<RequestState<GraphNode>>({ phase: 'idle' }));

function readOf(state: RequestState<GraphNode>, reload: () => void): EntityRead {
  switch (state.phase) {
    case 'idle':
      return { phase: 'idle', reload };
    case 'loading':
      return state.data === undefined ? { phase: 'loading', reload } : { phase: 'loading', node: state.data, reload };
    case 'ready':
      return { phase: 'ready', node: state.data, ...(state.failure === undefined ? {} : { failure: state.failure }), reload };
    case 'failed':
      return { phase: 'failed', failure: state.failure, reload };
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

const DO_NOTHING = (): void => undefined;

/** The read of the entity the inspector shows. It is asked for while the inspector shows the entity and stopped when it does not; in a part of the app drawn without reads it never asks. */
export function useEntityRead(ref: ElementRef | undefined, mask: boolean): EntityRead {
  const store = useContext(EntityReadContext);
  const request = store === undefined || ref === undefined ? undefined : store.forEntity(ref, mask);
  const state = useStoreSelector(request ?? NO_READ, (current) => current);
  useEffect(() => {
    if (request === undefined) return undefined;
    if (request.getState().phase === 'idle') request.reload();
    return () => {
      if (request.getState().phase === 'loading') request.cancel();
    };
  }, [request]);
  return readOf(state, request?.reload ?? DO_NOTHING);
}
