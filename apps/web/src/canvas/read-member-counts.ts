import type { Count, GraphEdge } from '@neburyx/contracts';
import type { LoadedGraph } from '../state/loaded-graph.js';

const READ_SCOPE = 'members read for the evidence panel';

/**
 * The count an aggregate is drawn with once the evidence panel has read its members. A lower bound that the read confirms as exact is drawn exact; a lower bound above what the read found cannot both be
 * true, so no number is drawn; a read above the lower bound leaves it, since the panel counts every member whatever the view's filters. Any other count is left as it is.
 */
export function drawnMemberCount(edge: GraphEdge, read: Count | undefined): Count | undefined {
  const drawn = edge.memberCount;
  if (!('aggregate' in edge.ref) || drawn === undefined || drawn.quality !== 'lowerBound' || drawn.value === undefined) return drawn;
  if (read?.quality !== 'exact' || read.value === undefined) return drawn;
  if (read.value === drawn.value) return read;
  return read.value < drawn.value ? { quality: 'unknown', scope: READ_SCOPE } : drawn;
}

/** The graph with each aggregate's member count as it is drawn; the same graph when no count changes. Loaded counts never use it: it is for the canvas, the walk and the menus only. */
export function withReadMemberCounts(graph: LoadedGraph, readOf: (edge: GraphEdge) => Count | undefined): LoadedGraph {
  let changed = false;
  const edges = graph.edges.map((edge) => {
    const memberCount = drawnMemberCount(edge, readOf(edge));
    if (memberCount === edge.memberCount) return edge;
    changed = true;
    return { ...edge, ...(memberCount === undefined ? {} : { memberCount }) };
  });
  return changed ? { ...graph, edges } : graph;
}
