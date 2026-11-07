import type { CoverageEntity, GraphEdge } from '@neburyx/contracts';
import { elementKey } from '../state/keys.js';
import type { LoadedGraph } from '../state/loaded-graph.js';

interface Loaded {
  readonly relationships: number;
  readonly exact: boolean;
}

/** What an edge puts at each of its ends: 1 for a stored relationship, its member count for an aggregate (inexact when that count is not `exact`), and nothing for a derived edge, which is not stored. */
function loadedBy(edge: GraphEdge): Loaded | undefined {
  if ('stableId' in edge.ref) return { relationships: 1, exact: true };
  if (!('aggregate' in edge.ref)) return undefined;
  const members = edge.memberCount;
  return { relationships: members?.value ?? 0, exact: members?.quality === 'exact' };
}

/** Each loaded entity with the relationships loaded at it, once for each end that is at it, so a self-loop counts twice. */
export function coverageEntitiesOf(graph: LoadedGraph): readonly CoverageEntity[] {
  const loaded = new Map<string, Loaded>();
  for (const edge of graph.edges) {
    const put = loadedBy(edge);
    if (put === undefined) continue;
    for (const end of [edge.from, edge.to]) {
      const key = elementKey(end);
      const held = loaded.get(key);
      loaded.set(key, { relationships: (held?.relationships ?? 0) + put.relationships, exact: (held?.exact ?? true) && put.exact });
    }
  }
  return graph.nodes.map((node) => {
    const held = loaded.get(elementKey(node.ref));
    return { ref: node.ref, loadedRelationships: held?.relationships ?? 0, loadedExact: held?.exact ?? true };
  });
}
