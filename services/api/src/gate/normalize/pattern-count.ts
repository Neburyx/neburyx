/** The count of a pattern run, normalized: the number of matches the probe read (at most the count cap plus one) and the flags of the read. It holds numbers and flags only, never an entity, a stable ID or a relationship. */
export interface NormalizedPatternCount {
  readonly estimateKind: 'pattern-count';
  /** The read found the anchor: it answered a row. */
  readonly anchorFound: boolean;
  /** The count row held a usable number (a whole number of at least 0); a row without one is an error for the caller, never a number. */
  readonly usable: boolean;
  /** The distinct matches read, at most the count cap plus one. */
  readonly matches: number;
  /** A step before the last reached the count cap, so some entities were not read. */
  readonly bounded: boolean;
  /** An entity was left out of the read because it is on a stop-list. */
  readonly stopListed: boolean;
  /** How many entities were left out of the read because they have too many relationships. */
  readonly supernodes: number;
}

export function isNormalizedPatternCount(item: unknown): item is NormalizedPatternCount {
  return typeof item === 'object' && item !== null && 'estimateKind' in item && item.estimateKind === 'pattern-count';
}

const wholeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function normalizePatternCount(rows: readonly Readonly<Record<string, unknown>>[]): NormalizedPatternCount {
  const [row] = rows;
  const value = row?.['matches'];
  const usable = wholeNumber(value);
  const skipped = row?.['supernodes'];
  return { estimateKind: 'pattern-count', anchorFound: row !== undefined, usable, matches: usable ? value : 0, bounded: row?.['bounded'] === true, stopListed: row?.['stopListed'] === true, supernodes: wholeNumber(skipped) ? skipped : 0 };
}
