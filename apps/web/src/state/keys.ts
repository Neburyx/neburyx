import type { EdgeRef, ElementRef, GraphEdge, GraphNode } from '@neburyx/contracts';

export const DEFAULT_POLICY_VERSION = 'community';
export const DEFAULT_FILTER_HASH = 'none';

export interface QueryKey {
  readonly sourceId: string;
  readonly principalId: string;
  readonly policyVersion: string;
  readonly filterHash: string;
  readonly params: string;
}

export function queryKeyText(key: QueryKey): string {
  return JSON.stringify([key.sourceId, key.principalId, key.policyVersion, key.filterHash, key.params]);
}

/** Node keys and relationship keys start with different tags, so one can never equal the other. */
export function elementKey(ref: ElementRef): string {
  return JSON.stringify(['node', ref.sourceId, ref.entityType, ref.stableId]);
}

export function edgeKey(ref: EdgeRef): string {
  if ('stableId' in ref) return JSON.stringify(['edge', ref.sourceId, 'stored', ref.stableId]);
  if ('aggregate' in ref) return JSON.stringify(['edge', ref.sourceId, 'aggregate', ref.aggregate.type, elementKey(ref.aggregate.from), elementKey(ref.aggregate.to)]);
  return JSON.stringify(['edge', ref.sourceId, 'derived', ref.derived.ruleId, elementKey(ref.derived.from), elementKey(ref.derived.to)]);
}

/** Whether a key names a relationship rather than an entity. */
export function isEdgeKey(key: string): boolean {
  return key.startsWith('["edge",');
}

/** Every source id a relationship ref names, its own and those of the entities nested in it. */
export function sourcesOfEdgeRef(ref: EdgeRef): string[] {
  if ('stableId' in ref) return [ref.sourceId];
  if ('aggregate' in ref) return [ref.sourceId, ref.aggregate.from.sourceId, ref.aggregate.to.sourceId];
  return [ref.sourceId, ref.derived.from.sourceId, ref.derived.to.sourceId];
}

export function sourcesOfNode(node: GraphNode): string[] {
  return [node.ref.sourceId];
}

export function sourcesOfEdge(edge: GraphEdge): string[] {
  return [...sourcesOfEdgeRef(edge.ref), edge.from.sourceId, edge.to.sourceId, ...(edge.derivation?.supportingEdgeRefs.flatMap(sourcesOfEdgeRef) ?? [])];
}
