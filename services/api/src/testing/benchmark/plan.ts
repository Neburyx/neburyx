/** Relationships of each type on one anchor. */
export const SIZES = [1_000, 10_000, 100_000] as const;
export type Size = (typeof SIZES)[number];

/** The page the product asks for by default. */
export const PAGE = 25;
/** The page used to walk to a deep position without timing: the largest the gate allows. */
export const WALK_PAGE = 50;
/** Failures in a row at one position after which its remaining samples are recorded as failures, and failures in a row at one row of the walk after which the read set ends. */
export const POSITION_FAILURES = 5;
export const WALK_FAILURES = 6;
/** Timed requests at each position: the pages from the position on, and when the order ends first, the position's own page again. */
export const SAMPLES_PER_POSITION = 30;
/** Untimed first pages before each read set is measured. */
export const WARM_UP_PAGES = 5;
export const DEEP_FRACTIONS = [0.1, 0.5, 0.9] as const;
/** Relationships to one neighbor in the aggregate shape. */
export const MEMBERS_PER_NEIGHBOR = 10;

export type ReadSet = 'dated' | 'undated' | 'aggregate' | 'plain' | 'all';
export const READ_SETS: readonly ReadSet[] = ['dated', 'undated', 'aggregate', 'plain', 'all'];

/** The relationship types of the fixture and the read set each belongs to. */
export const RELATIONSHIP_OF: Readonly<Record<Exclude<ReadSet, 'all'>, string>> = { dated: 'LINKED', undated: 'TIED', aggregate: 'NOTED', plain: 'PAID' };

export interface Position {
  readonly label: string;
  /** The row the timed pages start at, counted in rows of the read set's order. */
  readonly startRow: number;
}

/** The rows the order of a read set holds: the stored and plain read sets hold one row per relationship (plain: per neighbor, one relationship each), the aggregate one per neighbor, and all together the sum. */
export function rowsOf(set: ReadSet, size: number): number {
  const aggregate = size / MEMBERS_PER_NEIGHBOR;
  if (set === 'aggregate') return aggregate;
  if (set === 'all') return 3 * size + aggregate;
  return size;
}

/** The first page and the pages from 10 %, 50 % and 90 % of the order on, each starting on a page boundary of the walk page. A position that falls on an earlier one, or past the last row, is left out. */
export function positionsOf(rows: number): readonly Position[] {
  const first: Position = { label: 'first', startRow: 0 };
  const seen = new Set<number>([0]);
  const deep = DEEP_FRACTIONS.flatMap((fraction): Position[] => {
    const startRow = Math.floor((rows * fraction) / WALK_PAGE) * WALK_PAGE;
    if (seen.has(startRow) || startRow >= rows) return [];
    seen.add(startRow);
    return [{ label: `${Math.round(fraction * 100)}%`, startRow }];
  });
  return [first, ...deep];
}
