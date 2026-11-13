/** The count of a linked-entities run, normalized: the number of matches the probe read (at most the count cap plus one) and the flags of the read. It holds numbers and flags only, never an entity, a stable ID or a relationship. */
export interface NormalizedLinkedCount {
  readonly estimateKind: 'linked-entities-count';
  /** The read found the anchor: it answered a row. */
  readonly anchorFound: boolean;
  /** The count row held a usable number (a whole number of at least 0); a row without one is an error for the caller, never a number. */
  readonly usable: boolean;
  /** The distinct matches read, at most the count cap plus one. */
  readonly matches: number;
  /** The anchor's neighbors reached the count cap, so some were not read. */
  readonly frontierBounded: boolean;
  /** A middle entity was left out of the two-hop read as a supernode or because it is on a stop-list. */
  readonly supernodeSkipped: boolean;
}

export function isNormalizedLinkedCount(item: unknown): item is NormalizedLinkedCount {
  return typeof item === 'object' && item !== null && 'estimateKind' in item && item.estimateKind === 'linked-entities-count';
}

export function normalizeLinkedEntitiesCount(rows: readonly Readonly<Record<string, unknown>>[]): NormalizedLinkedCount {
  const [row] = rows;
  const value = row?.['matches'];
  const usable = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  return { estimateKind: 'linked-entities-count', anchorFound: row !== undefined, usable, matches: usable ? value : 0, frontierBounded: row?.['frontierBounded'] === true, supernodeSkipped: row?.['supernodeSkipped'] === true };
}
