import type { SourceProfile } from '@neburyx/contracts';
import type { LoadedGraph } from '../state/loaded-graph.js';

/** How many `pii` field keys the mapping lists for the entity types in the view; a type counts once, however many entities of it are loaded. Undefined while the profile is not known: that is not a count of none. */
export function sensitiveFieldCount(profile: SourceProfile | undefined, graph: LoadedGraph): number | undefined {
  if (profile === undefined) return undefined;
  const present = new Set(graph.nodes.map((node) => node.ref.entityType));
  return profile.entityTypes.filter((entry) => present.has(entry.type)).reduce((sum, entry) => sum + entry.pii.length, 0);
}

/** The names of the `pii` fields the mapping lists for the entity types in the view, each once, in the order of the profile; undefined while the profile is not known. */
export function sensitiveFieldNames(profile: SourceProfile | undefined, graph: LoadedGraph): readonly string[] | undefined {
  if (profile === undefined) return undefined;
  const present = new Set(graph.nodes.map((node) => node.ref.entityType));
  return [...new Set(profile.entityTypes.filter((entry) => present.has(entry.type)).flatMap((entry) => entry.pii))];
}

/** Whether a policy masks any property in the view: the request flag cannot lift that. */
export function isLockedByPolicy(graph: LoadedGraph): boolean {
  return graph.nodes.some((node) => node.properties.some((property) => property.maskedBy === 'policy')) || graph.edges.some((edge) => edge.properties.some((property) => property.maskedBy === 'policy'));
}
