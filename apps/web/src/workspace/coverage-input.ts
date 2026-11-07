import type { CoverageEntity } from '@neburyx/contracts';
import { elementKey } from '../state/keys.js';
import type { LoadedGraph } from '../state/loaded-graph.js';

/** Each loaded entity with the stored relationships loaded at it, once for each end that is at it, so a self-loop counts 2; aggregate and derived relationships are not stored and count 0. */
export function coverageEntitiesOf(graph: LoadedGraph): readonly CoverageEntity[] {
  const stored = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!('stableId' in edge.ref)) continue;
    for (const end of [edge.from, edge.to]) stored.set(elementKey(end), (stored.get(elementKey(end)) ?? 0) + 1);
  }
  return graph.nodes.map((node) => ({ ref: node.ref, storedRelationships: stored.get(elementKey(node.ref)) ?? 0 }));
}
