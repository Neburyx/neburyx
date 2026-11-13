/** The count of a shared-attribute run, normalized: the number of matches the probe read (at most the count cap plus one) and the flags of the read. It holds numbers and flags only, never an entity, a stable ID or a relationship. */
export interface NormalizedSharedCount {
  readonly estimateKind: 'shared-attribute-count';
  /** The read found the anchor: it answered a row. */
  readonly anchorFound: boolean;
  /** The count row held a usable number (a whole number of at least 0); a row without one is an error for the caller, never a number. */
  readonly usable: boolean;
  /** The distinct matches read, at most the count cap plus one. */
  readonly matches: number;
  /** The anchor's attribute nodes reached the cap, so some were not read. */
  readonly anchorBounded: boolean;
  /** The anchor holds an attribute node on the stop list, which the read skipped. */
  readonly skipped: boolean;
}

export function isNormalizedSharedCount(item: unknown): item is NormalizedSharedCount {
  return typeof item === 'object' && item !== null && 'estimateKind' in item && item.estimateKind === 'shared-attribute-count';
}

export function normalizeSharedAttributeCount(rows: readonly Readonly<Record<string, unknown>>[]): NormalizedSharedCount {
  const [row] = rows;
  const value = row?.['matches'];
  const usable = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  return { estimateKind: 'shared-attribute-count', anchorFound: row !== undefined, usable, matches: usable ? value : 0, anchorBounded: row?.['anchorBounded'] === true, skipped: row?.['skipped'] === true };
}
