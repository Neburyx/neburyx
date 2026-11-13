import type { GraphEdge, GraphNode } from '@neburyx/contracts';
import type { ClientState } from '../state/client-state.js';
import { edgeKey, elementKey, type QueryKey } from '../state/keys.js';

export interface HeldKeys {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
}

/** The keys of the entities and relationships the investigation holds now. */
export function heldKeysOf(state: ClientState): HeldKeys {
  const current = state.investigation.getState();
  return { nodes: new Set(current.nodeRefs.map(elementKey)), edges: new Set(current.edgeRefs.map(edgeKey)) };
}

export interface MergeInput {
  readonly sourceId: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Made only when something is new, so a merge that adds nothing leaves no result key behind. */
  readonly queryKey: () => QueryKey;
}

export interface Merged {
  /** What the investigation did not hold and now does. */
  readonly freshNodes: readonly GraphNode[];
  readonly freshEdges: readonly GraphEdge[];
  /** How many of the given nodes and relationships it already held: they are not replaced, so they keep the data they had. */
  readonly heldNodes: number;
  readonly heldEdges: number;
  /** The key the new items were stored under; absent when nothing was new. */
  readonly queryKey?: QueryKey;
}

/**
 * The one way a load puts what it brought into the loaded graph: what the investigation already holds is left as it is (identity per source, type and stable ID for an entity, and `edgeKey` for a relationship),
 * and what is new is stored as one result and referenced by one `setLoaded` call, so the graph never holds part of a load. A ref of another source is refused by the state with `SOURCE_MISMATCH`, before anything is stored.
 */
export function mergeIntoLoaded(state: ClientState, input: MergeInput): Merged {
  const held = heldKeysOf(state);
  const freshNodes = input.nodes.filter((node) => !held.nodes.has(elementKey(node.ref)));
  const freshEdges = input.edges.filter((edge) => !held.edges.has(edgeKey(edge.ref)));
  const merged: Merged = { freshNodes, freshEdges, heldNodes: input.nodes.length - freshNodes.length, heldEdges: input.edges.length - freshEdges.length };
  if (freshNodes.length === 0 && freshEdges.length === 0) return merged;
  const current = state.investigation.getState();
  const queryKey = input.queryKey();
  state.putResult(queryKey, { sourceId: input.sourceId, nodes: freshNodes, edges: freshEdges });
  state.setLoaded([...current.resultKeys, queryKey], [...current.nodeRefs, ...freshNodes.map((node) => node.ref)], [...current.edgeRefs, ...freshEdges.map((edge) => edge.ref)]);
  return { ...merged, queryKey };
}
