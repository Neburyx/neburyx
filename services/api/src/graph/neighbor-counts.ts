import type { Count, DegreeByType } from '@neburyx/contracts';
import { sumOf } from './degree-sum.js';

export const SCOPE_SUFFIX = 'mapped-relationship-ends';

/**
 * The counts grouped by the entity type at the other end. A pair with one mapped neighbor type gives that type its count; a pair with several gives each of them `unknown`, because the
 * server's count of the pair cannot be split by neighbor type cheaply and a guess would be shown as a number. A neighbor type reached through several pairs is the sum, with the weakest
 * quality of its parts. The types are in the order the pairs name them, each once.
 */
export function neighborCountsOf(byType: readonly DegreeByType[], floors: readonly (number | undefined)[] = []): { readonly entityType: string; readonly count: Count }[] {
  const parts = new Map<string, { count: Count; floor: number | undefined }[]>();
  for (const [index, entry] of byType.entries()) {
    for (const neighborType of entry.neighborTypes) {
      const scope = `degree:neighbor:${neighborType}:${SCOPE_SUFFIX}`;
      const part: Count = entry.neighborTypes.length === 1 ? entry.count : { quality: 'unknown', scope };
      parts.set(neighborType, [...(parts.get(neighborType) ?? []), { count: part, floor: floors[index] }]);
    }
  }
  return [...parts].map(([entityType, counts]) => ({ entityType, count: sumOf(counts.map((part) => part.count), `degree:neighbor:${entityType}:${SCOPE_SUFFIX}`, counts.map((part) => part.floor)) }));
}
