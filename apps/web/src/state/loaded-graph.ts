import type { Count, GraphEdge, GraphNode } from '@neburyx/contracts';
import type { InvestigationState } from './investigation-state.js';
import { edgeKey, elementKey, queryKeyText } from './keys.js';
import type { ServerState } from './server-state.js';

export interface LoadedGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly entities: Count;
  readonly relationships: Count;
}

const LOADED_SCOPE = 'loaded in this view';

function exact(value: number): Count {
  return { value, quality: 'exact', scope: LOADED_SCOPE };
}

/** The records of the results the investigation names that its refs name, once each; the counts are of these, and exact because they are what the client holds. A result cached for another principal, policy or filter is never read. */
export function deriveLoadedGraph(server: ServerState, investigation: InvestigationState): LoadedGraph {
  const wantedNodes = new Set(investigation.nodeRefs.map(elementKey));
  const wantedEdges = new Set(investigation.edgeRefs.map(edgeKey));
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const key of investigation.resultKeys) {
    const result = server.results.get(queryKeyText(key));
    if (result === undefined || result.sourceId !== investigation.sourceId) continue;
    for (const node of result.nodes) {
      const id = elementKey(node.ref);
      if (wantedNodes.has(id)) nodes.set(id, node);
    }
    for (const edge of result.edges) {
      const id = edgeKey(edge.ref);
      if (wantedEdges.has(id)) edges.set(id, edge);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], entities: exact(nodes.size), relationships: exact(edges.size) };
}

export interface EdgePartition {
  readonly drawable: readonly GraphEdge[];
  readonly notDrawable: readonly GraphEdge[];
}

/** A relationship can be drawn only between two loaded entities; the others are loaded but not drawable. */
export function partitionEdges(graph: LoadedGraph): EdgePartition {
  const loaded = new Set(graph.nodes.map((node) => elementKey(node.ref)));
  const drawable: GraphEdge[] = [];
  const notDrawable: GraphEdge[] = [];
  for (const edge of graph.edges) (loaded.has(elementKey(edge.from)) && loaded.has(elementKey(edge.to)) ? drawable : notDrawable).push(edge);
  return { drawable, notDrawable };
}

/** The keys of every element the canvas draws: each loaded entity and each relationship between two loaded entities. */
export function drawnKeys(graph: LoadedGraph): ReadonlySet<string> {
  return new Set([...graph.nodes.map((node) => elementKey(node.ref)), ...partitionEdges(graph).drawable.map((edge) => edgeKey(edge.ref))]);
}
