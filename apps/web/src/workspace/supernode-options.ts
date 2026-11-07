import type { Count, DegreePreview, SourceProfile } from '@neburyx/contracts';

export interface RelationshipOption {
  readonly type: string;
  /** The entity types at the other end of the rows of this relationship type that have the node's type at one end, in mapping order. */
  readonly neighborTypes: readonly string[];
  /** Whether every, some or none of those rows map an observed time. */
  readonly observed: 'all' | 'some' | 'none';
}

/** The mapped relationship types with the node's entity type at one end, each once, in the order of the mapping. */
export function relationshipOptions(profile: SourceProfile | undefined, entityType: string): readonly RelationshipOption[] {
  const rows = (profile?.relationshipTypes ?? []).filter((row) => row.from === entityType || row.to === entityType);
  return [...new Set(rows.map((row) => row.type))].map((type) => {
    const own = rows.filter((row) => row.type === type);
    const dated = own.filter((row) => row.observedAt !== null).length;
    return { type, neighborTypes: [...new Set(own.flatMap((row) => [...(row.from === entityType ? [row.to] : []), ...(row.to === entityType ? [row.from] : [])]))], observed: dated === 0 ? 'none' : dated === own.length ? 'all' : 'some' };
  });
}

/** Every neighbor type the panel offers over all sourced types: those the preview names, in its order, then any the mapping gives that it did not. */
export function allNeighborTypes(preview: DegreePreview | undefined, mapped: readonly string[]): readonly string[] {
  return [...new Set([...(preview?.byNeighborType.map((entry) => entry.entityType) ?? []), ...mapped])];
}

export interface DirectionCount {
  readonly direction: 'out' | 'in';
  readonly count: Count;
}

/** The count of a relationship type as the preview gives it: one count for each direction row, never added together. */
export function relationshipCounts(preview: DegreePreview | undefined, relationshipType: string): readonly DirectionCount[] {
  return (preview?.byType ?? []).filter((row) => row.relationshipType === relationshipType).map((row) => ({ direction: row.direction, count: row.count }));
}

export type NeighborCount = { readonly over: 'all'; readonly count: Count | undefined } | { readonly over: 'one'; readonly counts: readonly DirectionCount[] };

/**
 * The count the preview gives for a neighbor type. Over all sourced types it is the entry of `byNeighborType`. Over one relationship type it is given only by a row of that type whose one neighbor type is this one, one count for each direction row;
 * a row that names several neighbor types gives no number for any of them, and nothing is added, subtracted or guessed.
 */
export function neighborCount(preview: DegreePreview | undefined, neighborType: string, relationshipType: string | undefined): NeighborCount {
  if (relationshipType === undefined) return { over: 'all', count: preview?.byNeighborType.find((candidate) => candidate.entityType === neighborType)?.count };
  const rows = (preview?.byType ?? []).filter((row) => row.relationshipType === relationshipType && row.neighborTypes.length === 1 && row.neighborTypes[0] === neighborType);
  return { over: 'one', counts: rows.map((row) => ({ direction: row.direction, count: row.count })) };
}

export const sameTypes = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => (a === undefined || a.length === 0 ? b === undefined || b.length === 0 : b !== undefined && a.length === b.length && a.every((type, at) => type === b[at]));
