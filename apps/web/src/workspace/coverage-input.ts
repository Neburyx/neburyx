import type { CoverageEntity, GraphEdge } from '@neburyx/contracts';
import { elementKey } from '../state/keys.js';
import type { LoadedGraph } from '../state/loaded-graph.js';

type LoadedQuality = CoverageEntity['loadedQuality'];

interface Loaded {
  readonly relationships: number;
  readonly quality: LoadedQuality;
}

const STRENGTH: readonly LoadedQuality[] = ['exact', 'estimated', 'unknown'];

const weakest = (a: LoadedQuality, b: LoadedQuality): LoadedQuality => (STRENGTH.indexOf(a) >= STRENGTH.indexOf(b) ? a : b);

function qualityOfMembers(members: GraphEdge['memberCount']): LoadedQuality {
  if (members?.quality === 'exact') return 'exact';
  return members?.quality === 'estimated' && members.value !== undefined ? 'estimated' : 'unknown';
}

/** What an edge puts at each of its ends: 1 for a stored relationship, its member count for an aggregate (as sure as that count is, and not known for a lower bound or no value), and nothing for a derived edge, which is not stored. */
function loadedBy(edge: GraphEdge): Loaded | undefined {
  if ('stableId' in edge.ref) return { relationships: 1, quality: 'exact' };
  if (!('aggregate' in edge.ref)) return undefined;
  return { relationships: edge.memberCount?.value ?? 0, quality: qualityOfMembers(edge.memberCount) };
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
      loaded.set(key, { relationships: (held?.relationships ?? 0) + put.relationships, quality: weakest(held?.quality ?? 'exact', put.quality) });
    }
  }
  return graph.nodes.map((node) => {
    const held = loaded.get(elementKey(node.ref));
    return { ref: node.ref, loadedRelationships: held?.relationships ?? 0, loadedQuality: held?.quality ?? 'exact' };
  });
}
