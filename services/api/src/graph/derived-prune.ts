import type { GraphEdge, GraphNode } from '@neburyx/contracts';
import { canonicalJson } from '../gate/cursor/binding.js';

export interface DerivedRunResult {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/**
 * What of a rule run is kept after the gate has dropped the derived edges it may not show: the derived edges that remain, the supporting edges they name and the nodes at the ends of those edges. A node
 * reached only through a derived edge that was dropped, and a supporting edge only that edge named, are left out, so nothing of a hidden relationship is returned.
 */
export function prunedRunOf(result: DerivedRunResult): DerivedRunResult {
  const derived = result.edges.filter((edge) => edge.semantics === 'derived');
  const named = new Set(derived.flatMap((edge) => edge.derivation?.supportingEdgeRefs ?? []).map((ref) => canonicalJson(ref)));
  const supports = result.edges.filter((edge) => edge.semantics !== 'derived' && named.has(canonicalJson(edge.ref)));
  const edges = [...supports, ...derived];
  const needed = new Set(edges.flatMap((edge) => [canonicalJson(edge.from), canonicalJson(edge.to)]));
  return { nodes: result.nodes.filter((node) => needed.has(canonicalJson(node.ref))), edges };
}
