import type { AggregateEdgeRef, DerivedEdgeRef, ExportFormat, ExportRequest, GraphEdge, StoredEdgeRef } from '@neburyx/contracts';
import { ERROR_TABLE } from '@neburyx/contracts';
import type { ApiFailure } from '../api/client.js';
import type { LoadedGraph } from '../state/loaded-graph.js';

/** The references of what the canvas shows: the server reads each through the gate, so no value from the browser's copy goes in a file. */
export function exportRequestOf(graph: LoadedGraph, format: ExportFormat): ExportRequest {
  const edges: StoredEdgeRef[] = [];
  const aggregates: AggregateEdgeRef[] = [];
  const derived: DerivedEdgeRef[] = [];
  for (const edge of graph.edges) sort(edge, edges, aggregates, derived);
  return { kind: 'view', format, entities: graph.nodes.map((node) => node.ref), edges, aggregates, derived };
}

function sort(edge: GraphEdge, edges: StoredEdgeRef[], aggregates: AggregateEdgeRef[], derived: DerivedEdgeRef[]): void {
  const { ref } = edge;
  if ('stableId' in ref) edges.push(ref);
  else if ('aggregate' in ref) aggregates.push(ref);
  else derived.push(ref);
}

/** A fresh idempotency key for each Download the person starts. */
export function newExportKey(): string {
  return crypto.randomUUID();
}

/**
 * Which key a retry sends. An answer that was kept for the key (a client error, a rate limit) would only be replayed, so a retry after one needs a new key; after a server error the server forgot the key, and
 * after an answer that never arrived the same key is what makes the retry safe.
 */
export function keyAfter(failure: ApiFailure, key: string): string {
  const status = failure.code in ERROR_TABLE ? ERROR_TABLE[failure.code as keyof typeof ERROR_TABLE].status : undefined;
  return status !== undefined && status < 500 ? newExportKey() : key;
}
