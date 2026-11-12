import type { Count, CoverageEntity } from '@neburyx/contracts';
import { isUnmappedEdge, isUnmappedNode } from '../draft/unmapped.js';
import { elementKey } from '../state/keys.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { endContributionOf } from './loaded-ends.js';

type LoadedQuality = CoverageEntity['loadedQuality'];

interface Loaded {
  readonly relationships: number;
  readonly quality: LoadedQuality;
}

const STRENGTH: readonly LoadedQuality[] = ['exact', 'estimated', 'unknown'];

const weakest = (a: LoadedQuality, b: LoadedQuality): LoadedQuality => (STRENGTH.indexOf(a) >= STRENGTH.indexOf(b) ? a : b);

function qualityOfPut(put: Count): LoadedQuality {
  if (put.quality === 'exact' && put.value !== undefined) return 'exact';
  return put.quality === 'estimated' && put.value !== undefined ? 'estimated' : 'unknown';
}

/** Each loaded entity with the relationships loaded at it, once for each end that is at it, so a self-loop counts twice. */
export function coverageEntitiesOf(graph: LoadedGraph): readonly CoverageEntity[] {
  const loaded = new Map<string, Loaded>();
  for (const edge of graph.edges) {
    if (isUnmappedEdge(edge)) continue;
    const put = endContributionOf(edge);
    if (put === undefined) continue;
    const quality = qualityOfPut(put);
    for (const end of [edge.from, edge.to]) {
      const key = elementKey(end);
      const held = loaded.get(key);
      loaded.set(key, { relationships: (held?.relationships ?? 0) + (put.value ?? 0), quality: weakest(held?.quality ?? 'exact', quality) });
    }
  }
  return graph.nodes.filter((node) => !isUnmappedNode(node)).map((node) => {
    const held = loaded.get(elementKey(node.ref));
    return { ref: node.ref, loadedRelationships: held?.relationships ?? 0, loadedQuality: held?.quality ?? 'exact' };
  });
}
