import type { EdgeRef, ElementRef, GraphEdge, GraphNode } from '@neburyx/contracts';
import type { QueryKey } from './keys.js';
import type { GraphResult } from './server-state.js';

export function ref(sourceId: string, entityType: string, stableId: string): ElementRef {
  return { sourceId, entityType, stableId };
}

export function node(sourceId: string, stableId: string): GraphNode {
  return {
    ref: ref(sourceId, 'type-a', stableId),
    display: { title: stableId, type: 'type-a' },
    properties: [],
    qualityFlags: [],
    provenanceRefs: [],
    authorization: { canInspect: true, canExport: true },
  };
}

export function edgeRef(sourceId: string, stableId: string, type = 'rel-a', from = 'type-a', to = 'type-a'): EdgeRef {
  return { sourceId, type, from, to, stableId };
}

export function edge(sourceId: string, stableId: string, from: string, to: string): GraphEdge {
  return { ref: edgeRef(sourceId, stableId), from: ref(sourceId, 'type-a', from), to: ref(sourceId, 'type-a', to), type: 'rel-a', direction: 'from-to', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] };
}

export function key(sourceId: string, params = 'seed-1'): QueryKey {
  return { sourceId, principalId: 'principal-1', policyVersion: 'community', filterHash: 'none', params, mask: false };
}

export function result(sourceId: string, nodeIds: readonly string[], edges: ReadonlyArray<readonly [string, string, string]> = []): GraphResult {
  return { sourceId, nodes: nodeIds.map((id) => node(sourceId, id)), edges: edges.map(([id, from, to]) => edge(sourceId, id, from, to)) };
}
