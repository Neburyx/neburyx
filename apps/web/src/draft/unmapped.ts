import type { GraphEdge, GraphNode, QueryContextDocument, UnmappedItems } from '@neburyx/contracts';

type StoredEdge = QueryContextDocument['loaded']['edges'][number];

/** Marks an item the current mapping no longer covers: drawn as a placeholder, never read from the source. */
export const UNMAPPED_FLAG = 'no-longer-mapped';
export const UNMAPPED_TITLE = 'Unmapped item';
export const NO_LONGER_MAPPED = 'No longer mapped';

export const isUnmappedNode = (node: Pick<GraphNode, 'qualityFlags'>): boolean => node.qualityFlags.includes(UNMAPPED_FLAG);
export const isUnmappedEdge = (edge: Pick<GraphEdge, 'qualityFlags'>): boolean => edge.qualityFlags.includes(UNMAPPED_FLAG);

const nodeIdentity = (type: string, id: string): string => `${type}\u0000${id}`;
const edgeIdentity = (edge: StoredEdge): string => JSON.stringify([edge.t, edge.from.t, edge.from.id, edge.to.t, edge.to.id, edge.id ?? null, edge.ruleId ?? null]);

export function withoutUnmapped(queryContext: QueryContextDocument, unmapped: UnmappedItems | undefined): QueryContextDocument {
  if (unmapped === undefined) return queryContext;
  const nodes = new Set(unmapped.nodes.map((node) => nodeIdentity(node.t, node.id)));
  const edges = new Set(unmapped.edges.map(edgeIdentity));
  return { ...queryContext, loaded: { nodes: queryContext.loaded.nodes.filter((node) => !nodes.has(nodeIdentity(node.t, node.id))), edges: queryContext.loaded.edges.filter((edge) => !edges.has(edgeIdentity(edge))) } };
}

export const isUnmappedStart = (unmapped: UnmappedItems | undefined, start: { readonly entityType: string; readonly stableId: string }): boolean => unmapped?.nodes.some((node) => node.t === start.entityType && node.id === start.stableId) === true;

export function placeholderNode(sourceId: string, entry: { readonly t: string; readonly id: string }): GraphNode {
  return {
    ref: { sourceId, entityType: entry.t, stableId: entry.id },
    display: { title: UNMAPPED_TITLE, type: entry.t },
    properties: [],
    qualityFlags: [UNMAPPED_FLAG],
    provenanceRefs: [],
    authorization: { canInspect: false, canExport: false },
  };
}

export function placeholderEdge(sourceId: string, entry: StoredEdge): GraphEdge {
  const from = { sourceId, entityType: entry.from.t, stableId: entry.from.id };
  const to = { sourceId, entityType: entry.to.t, stableId: entry.to.id };
  const base = { from, to, type: entry.t, direction: 'from-to' as const, semantics: 'unknown' as const, properties: [], evidenceRefs: [], qualityFlags: [UNMAPPED_FLAG] };
  if (entry.id !== undefined) return { ...base, ref: { sourceId, type: entry.t, from: entry.from.t, to: entry.to.t, stableId: entry.id } };
  if (entry.ruleId !== undefined) return { ...base, ref: { sourceId, derived: { ruleId: entry.ruleId, from, to } } };
  return { ...base, ref: { sourceId, aggregate: { type: entry.t, from, to } }, memberCount: { quality: 'unknown', scope: UNMAPPED_FLAG } };
}
