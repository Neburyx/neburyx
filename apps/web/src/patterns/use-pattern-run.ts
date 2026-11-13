import { useEffect, useMemo } from 'react';
import type { ApiClient } from '../api/client.js';
import { useStoreSelector } from '../state/store.js';
import { createPatternRunStore, type PatternRunStore, type PatternRunView } from './pattern-run-store.js';

export type PatternRun = PatternRunView & Pick<PatternRunStore, 'run' | 'cancel' | 'clear'>;

/** The run store of the panel: made for the source and the mask, and disposed (the run aborted) when the panel goes or either changes. */
export function usePatternRun(client: ApiClient, sourceId: string, mask: boolean): PatternRun {
  const store = useMemo(() => createPatternRunStore(client, sourceId, mask), [client, sourceId, mask]);
  useEffect(() => () => store.dispose(), [store]);
  const view = useStoreSelector(store, (current) => current);
  return { ...view, run: store.run, cancel: store.cancel, clear: store.clear };
}
