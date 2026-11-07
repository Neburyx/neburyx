import { createContext, useContext, type ReactNode } from 'react';
import type { ElementRef, SourceProfile } from '@neburyx/contracts';
import type { ExpandStore } from '../api/expand-store.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { nodeRefOfKey } from '../state/keys.js';
import { useStoreSelector } from '../state/store.js';
import { NO_NEIGHBOR_TYPES, cannotExpandText } from './expand-copy.js';

const ExpandContext = createContext<ExpandStore | undefined>(undefined);

export function ExpandProvider({ store, children }: { readonly store: ExpandStore; readonly children: ReactNode }) {
  return <ExpandContext.Provider value={store}>{children}</ExpandContext.Provider>;
}

/** The store when one is provided, and nothing in a part of the app drawn without expansions. */
export function useExpandStoreWhenProvided(): ExpandStore | undefined {
  return useContext(ExpandContext);
}

export function useExpandStore(): ExpandStore {
  const store = useContext(ExpandContext);
  if (store === undefined) throw new Error('the expansions are not provided');
  return store;
}

/** Every entity type at the other end of a mapped relationship of the entity type, each once, in the order of the mapping. */
export function neighborTypesOf(profile: SourceProfile | undefined, entityType: string): readonly string[] {
  const ends = (profile?.relationshipTypes ?? []).flatMap((row) => [...(row.from === entityType ? [row.to] : []), ...(row.to === entityType ? [row.from] : [])]);
  return [...new Set(ends)];
}

export type ExpandResult = 'started' | 'no-stable-id' | 'no-neighbor-types';

/** What a command that expands a node needs: the node it names, the neighbor types the mapping gives it, and the store that loads them. */
export interface ExpansionControls {
  /** Loads the first page of every mapped neighbor type of the node, as one request; nothing is requested for a key that names no node with a stable ID. */
  expandNode(key: string): ExpandResult;
  readonly store: ExpandStore;
}

/** The controls over a store and the profile of the bound source. */
export function expansionControlsOf(store: ExpandStore, profile: SourceProfile | undefined): ExpansionControls {
  return {
    store,
    expandNode(key) {
      const ref: ElementRef | undefined = nodeRefOfKey(key);
      if (ref === undefined) {
        store.report(cannotExpandText(1));
        return 'no-stable-id';
      }
      const types = neighborTypesOf(profile, ref.entityType);
      if (types.length === 0) {
        store.report(NO_NEIGHBOR_TYPES);
        return 'no-neighbor-types';
      }
      void store.expand(ref, types);
      return 'started';
    },
  };
}

export function useExpansionControls(): ExpansionControls | undefined {
  const store = useContext(ExpandContext);
  const profile = useProfileWhenProvided();
  return store === undefined ? undefined : expansionControlsOf(store, profile);
}

export function useNodeExpansion(ref: ElementRef | undefined) {
  const store = useExpandStore();
  return useStoreSelector(store.view, () => (ref === undefined ? undefined : store.of(ref)));
}
