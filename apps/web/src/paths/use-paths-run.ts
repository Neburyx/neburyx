import { useMemo } from 'react';
import type { ApiClient } from '../api/client.js';
import { useStoreSelector } from '../state/store.js';
import { createPathsRunStore, type PathsRunOptions, type PathsRunStore, type PathsRunView } from './paths-run-store.js';

export type PathsRun = PathsRunView & Pick<PathsRunStore, 'run' | 'cancel' | 'clear'>;

interface Held {
  readonly owner: object;
  readonly key: string;
  readonly store: PathsRunStore;
}

/** The search of the app: kept when the panel is closed, so that a search that is still running, its list and its banners outlive the panel; replaced (the older search aborted and its banners taken down) when the source, the investigation or the mask changes. */
let held: Held | undefined;

function storeFor(owner: object, key: string, client: ApiClient, sourceId: string, options: PathsRunOptions): PathsRunStore {
  if (held !== undefined && held.owner === owner && held.key === key) return held.store;
  held?.store.dispose();
  const store = createPathsRunStore(client, sourceId, options);
  held = { owner, key, store };
  return store;
}

/** Throws the held search away, aborting it and taking its banners down: what the context does when the source, the investigation or the mask changes, whether or not the panel is shown. */
export function disposeHeldPathsRun(): void {
  held?.store.dispose();
  held = undefined;
}

/**
 * The run store of the app for the context: `owner` is the client the app was given, which tells one app from another (a test's from the next), and `contextKey` names the source, the investigation and the mask
 * the answers belong to.
 */
export function usePathsRun(owner: object, contextKey: string, client: ApiClient, sourceId: string, options: PathsRunOptions): PathsRun {
  const store = useMemo(() => storeFor(owner, contextKey, client, sourceId, options), [owner, contextKey, client, sourceId, options]);
  const view = useStoreSelector(store, (current) => current);
  return { ...view, run: store.run, cancel: store.cancel, clear: store.clear };
}
