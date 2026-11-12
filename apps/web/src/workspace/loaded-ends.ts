import type { Count, GraphEdge } from '@neburyx/contracts';

export const LOADED_SCOPE = 'loaded in this view';

/**
 * What a relationship puts at each of its ends, as a degree count counts: 1 for a stored relationship, its member count for a stored aggregate, and nothing for one that is not stored (a derived relationship, or a saved one
 * that has not been read), which a degree count does not include. A relationship from an entity to itself puts it at both of its ends, which the callers handle. The one definition behind the inspector's loaded counts and the
 * coverage request, so that the header and the inspector cannot count differently.
 */
export function endContributionOf(edge: GraphEdge): Count | undefined {
  if (edge.semantics !== 'stored') return undefined;
  if ('aggregate' in edge.ref) return edge.memberCount ?? { quality: 'unknown', scope: LOADED_SCOPE };
  return 'stableId' in edge.ref ? { value: 1, quality: 'exact', scope: LOADED_SCOPE } : undefined;
}
