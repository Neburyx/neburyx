import type { Count, GraphEdge, GraphNode, SummaryReading } from '@neburyx/contracts';

const ref = (entityType: string, stableId: string) => ({ sourceId: 'demo', entityType, stableId });

export const prop = (key: string, value: unknown, masked = false): GraphNode['properties'][number] => ({ key, value, dataClass: 'text', masked });

export const node = (entityType: string, stableId: string, title: string, properties: GraphNode['properties'] = []): GraphNode => ({
  ref: ref(entityType, stableId),
  display: { title, type: entityType },
  properties,
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});

export const edge = (type: string, stableId: string, from: GraphNode['ref'], to: GraphNode['ref'], extra: Partial<GraphEdge> = {}): GraphEdge => ({
  ref: { sourceId: 'demo', type, from: from.entityType, to: to.entityType, stableId },
  from,
  to,
  type,
  direction: 'from-to',
  semantics: 'stored',
  properties: [],
  evidenceRefs: [],
  qualityFlags: [],
  ...extra,
});

const EXACT_NONE: Count = { value: 0, quality: 'exact', scope: 'coverage' };

export const reading = (nodes: readonly GraphNode[], edges: readonly GraphEdge[] = [], over: Partial<SummaryReading> = {}): SummaryReading => ({
  nodes: [...nodes],
  edges: [...edges],
  unresolved: 0,
  omitted: false,
  notRetrieved: EXACT_NONE,
  uncounted: 0,
  ...over,
});
