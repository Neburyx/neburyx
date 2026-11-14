/** The count of a shortest-paths run, normalized: the relationships at the two ends the probe read (each at most the count cap plus one) and whether both ends were found. It holds numbers and flags only, never an entity. */
export interface NormalizedPathsCount {
  readonly estimateKind: 'shortest-paths-count';
  /** The first end was found (the probe answered a row) and so was the second. */
  readonly anchorFound: boolean;
  /** The count row held two whole numbers of at least 0; a row without them is an error for the caller, never a number. */
  readonly usable: boolean;
  /** The relationships read at the two ends together. */
  readonly matches: number;
}

export function isNormalizedPathsCount(item: unknown): item is NormalizedPathsCount {
  return typeof item === 'object' && item !== null && 'estimateKind' in item && item.estimateKind === 'shortest-paths-count';
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function normalizeShortestPathsCount(rows: readonly Readonly<Record<string, unknown>>[]): NormalizedPathsCount {
  const [row] = rows;
  const [from, to] = [row?.['fromDegree'], row?.['toDegree']];
  const usable = isCount(from) && isCount(to);
  return { estimateKind: 'shortest-paths-count', anchorFound: row !== undefined && row['toFound'] === true, usable, matches: usable ? from + to : 0 };
}
