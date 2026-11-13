import type { ClientState } from '../state/client-state.js';
import { isSourceChanged } from '../state/investigation-state.js';
import type { ApiClient, ApiResult } from './client.js';

type GuardedRead = 'getEntity' | 'getEdge' | 'lookupEntity' | 'searchEntities' | 'searchMore' | 'previewExpansion' | 'expandNeighbors' | 'derivedNeighbors' | 'graphCoverage' | 'readRefs' | 'createExport' | 'runTemplate';

/** Nothing was sent: the answer says only that the request ended, which no store shows as a failure. */
const NOT_SENT: ApiResult<never> = { ok: false, failure: { code: 'ABORTED' } };

/**
 * Refuses to send any read of the source while the investigation on screen has a source that was re-pointed or removed: the answer is that the request ended, and nothing reaches the network. The tool strip is dimmed and the saved items are
 * placeholders that are never read, so this is the second lock on the same rule, for a control or a key that still reaches a store.
 */
export function withoutReadsWhileSourceChanged(client: ApiClient, state: ClientState): ApiClient {
  const changed = (): boolean => isSourceChanged(state.investigation.getState().record?.sourceState);
  /** Looks the method up on the client at each call, so a client whose methods are replaced later is still the one asked. */
  const guard = <Name extends GuardedRead>(name: Name): ApiClient[Name] => ((...args: unknown[]) => (changed() ? Promise.resolve(NOT_SENT) : (client[name] as (...call: unknown[]) => unknown)(...args))) as ApiClient[Name];
  return {
    ...client,
    getEntity: guard('getEntity'),
    getEdge: guard('getEdge'),
    lookupEntity: guard('lookupEntity'),
    searchEntities: guard('searchEntities'),
    searchMore: guard('searchMore'),
    previewExpansion: guard('previewExpansion'),
    expandNeighbors: guard('expandNeighbors'),
    derivedNeighbors: guard('derivedNeighbors'),
    graphCoverage: guard('graphCoverage'),
    readRefs: guard('readRefs'),
    createExport: guard('createExport'),
    runTemplate: guard('runTemplate'),
  };
}
