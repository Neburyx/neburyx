import type { GraphEdge } from '@neburyx/contracts';

/** What a walk of the whole order of a read set must show. */
export interface WalkExpectation {
  /** The rows the order holds. */
  readonly rows: number;
  /** The relationships the rows stand for: each row counts its members, or one. */
  readonly relationships: number;
}

export interface WalkedPage {
  readonly edges: readonly GraphEdge[];
  readonly hasMore: boolean;
}

export const keyOf = (edge: GraphEdge): string => JSON.stringify([edge.type, edge.ref]);

/** The time a row is ordered by: a stored edge's `observedAt`, an aggregate's latest. */
export const timeOf = (edge: GraphEdge): string | undefined => edge.observedAt ?? edge.observedLast;

const membersOf = (edge: GraphEdge): number => edge.memberCount?.value ?? 1;

/**
 * Fails when a walk of pages repeats a row, misses one, ends with a page that has more, stops short of the last page, or puts a row with no time before one that has a time
 * (rows with no sort value come last, in their own phase). Returns the keys of the rows in the order walked.
 */
export function checkWalk(pages: readonly WalkedPage[], expected: WalkExpectation, where: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  let relationships = 0;
  let undated = false;
  for (const [index, page] of pages.entries()) {
    if (page.hasMore !== (index < pages.length - 1)) throw new Error(`${where}: page ${index + 1} of ${pages.length} ${page.hasMore ? 'has more' : 'ends the order'}`);
    for (const edge of page.edges) {
      const key = keyOf(edge);
      if (seen.has(key)) throw new Error(`${where}: the row ${key} was returned twice`);
      seen.add(key);
      keys.push(key);
      relationships += membersOf(edge);
      if (timeOf(edge) === undefined) undated = true;
      else if (undated) throw new Error(`${where}: the row ${key} has a time and comes after a row with none`);
    }
  }
  if (keys.length !== expected.rows) throw new Error(`${where}: ${keys.length} rows walked, ${expected.rows} expected`);
  if (relationships !== expected.relationships) throw new Error(`${where}: the rows stand for ${relationships} relationships, ${expected.relationships} expected`);
  return keys;
}

/** Fails when two walks of the same order, at different page sizes, differ, naming the first row that does. */
export function checkSameSequence(first: readonly string[], second: readonly string[], where: string): void {
  if (first.length !== second.length) throw new Error(`${where}: ${first.length} rows against ${second.length}`);
  const at = first.findIndex((key, index) => key !== second[index]);
  if (at !== -1) throw new Error(`${where}: the sequences differ at row ${at + 1}`);
}
