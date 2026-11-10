import { edgeRefSegmentOf } from '@neburyx/contracts';
import { isUnmappedEdge, isUnmappedNode } from '../draft/unmapped.js';
import type { ClientState } from '../state/client-state.js';
import type { ApiClient, ApiResult } from './client.js';

const GONE: ApiResult<never> = { ok: false, failure: { code: 'NOT_FOUND', message: 'This item is no longer mapped.', retryable: false, traceId: '' } };

/** A read about a placeholder is answered as not found and never sent: the source has no such type to read. */
export function withoutUnmappedReads(client: ApiClient, state: ClientState): ApiClient {
  const types = (): ReadonlySet<string> => new Set(state.loadedGraph().nodes.filter(isUnmappedNode).map((node) => node.ref.entityType));
  const edges = (): ReadonlySet<string> => new Set(state.loadedGraph().edges.filter(isUnmappedEdge).map((edge) => edgeRefSegmentOf(edge.ref)));
  return {
    ...client,
    getEntity: (ref, options, signal) => (types().has(ref.entityType) ? Promise.resolve(GONE) : client.getEntity(ref, options, signal)),
    getEdge: (ref, options, signal) => (edges().has(edgeRefSegmentOf(ref)) ? Promise.resolve(GONE) : client.getEdge(ref, options, signal)),
    previewExpansion: (request, signal) => (types().has(request.ref.entityType) ? Promise.resolve(GONE) : client.previewExpansion(request, signal)),
    expandNeighbors: (request, signal) => (types().has(request.ref.entityType) ? Promise.resolve(GONE) : client.expandNeighbors(request, signal)),
    derivedNeighbors: (request, signal) => (types().has(request.ref.entityType) ? Promise.resolve(GONE) : client.derivedNeighbors(request, signal)),
  };
}
