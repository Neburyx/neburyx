import type { ElementRef } from '@neburyx/contracts';
import { normalizeRows, type Normalized, type NormalizeContext } from './index.js';
import { isPlainNode, normalizeNode, normalizeNodeAs, type PlainNode } from './node.js';

/** One match of a linked-entities run with how it was reached: in one or two hops, and the entity in between when there were two. */
export interface LinkedMatch {
  readonly match: ElementRef;
  readonly hops: 1 | 2;
  readonly through?: ElementRef;
}

/** A linked-entities run, normalized: the nodes and edges of every row, the matches with their hops, the supernodes that were not traversed, and the flags the read raised. */
export interface NormalizedLinked extends Normalized {
  readonly matches: readonly LinkedMatch[];
  /** The read found the anchor: it answered at least one row, even one with no match. */
  readonly anchorFound: boolean;
  /** A bound of the read (the neighbors or the second steps) was hit, so there may be more matches. */
  readonly bounded: boolean;
  /** An entity on a stop-list was not traversed. */
  readonly stopListed: boolean;
  /** Entities with more relationships than the count cap, which were not traversed, at most the request's limit of them. */
  readonly supernodes: readonly ElementRef[];
}

export function isNormalizedLinked(item: unknown): item is NormalizedLinked {
  if (typeof item !== 'object' || item === null) return false;
  return 'nodes' in item && Array.isArray(item.nodes) && 'edges' in item && Array.isArray(item.edges) && 'warnings' in item && Array.isArray(item.warnings) && 'matches' in item && Array.isArray(item.matches) && 'supernodes' in item && Array.isArray(item.supernodes) && 'anchorFound' in item;
}

const nodesIn = (value: unknown): readonly PlainNode[] => (Array.isArray(value) ? value : [value]).filter(isPlainNode);

function refOf(context: NormalizeContext, plain: PlainNode, type?: string): ElementRef | undefined {
  const [result] = normalizeNodeAs(context, plain, type === undefined ? undefined : [type]);
  return result !== undefined && 'node' in result ? result.node.ref : undefined;
}

/**
 * The nodes and edges of the rows of a linked-entities read, the anchor and the matches read as the types the request named, the entity in between and the supernodes as the type their labels give, and the matches with
 * their hop count. A match with no usable stable ID is left out and counted by reason, as for every read.
 */
export function normalizeLinkedEntities(context: NormalizeContext, rows: readonly Readonly<Record<string, unknown>>[]): NormalizedLinked {
  const [anchorType, targetType] = [context.params?.['entityType'], context.params?.['targetType']];
  const empty = { matches: [], anchorFound: false, bounded: false, stopListed: false, supernodes: [] };
  if (typeof anchorType !== 'string' || typeof targetType !== 'string') return { ...normalizeRows(context, []), ...empty };
  // the member count of an aggregate edge is exact only when nothing was cut: not the matches, not a bound of the read, not the members of an edge
  const shown = { ...context, hasMore: context.hasMore || rows.some((row) => row['bounded'] === true || row['membersCut'] === true) };
  const expected = new Map<string, readonly string[]>();
  const expect = (plain: PlainNode, type: string): void => void expected.set(plain.elementId, [...new Set([...(expected.get(plain.elementId) ?? []), type])]);
  for (const row of rows) {
    for (const plain of nodesIn(row['a'])) expect(plain, anchorType);
    for (const plain of nodesIn(row['x'])) expect(plain, targetType);
  }
  const normalized = normalizeRows(shown, rows, expected);
  const matches: LinkedMatch[] = [];
  const supernodes: ElementRef[] = [];
  for (const row of rows) {
    for (const plain of nodesIn(row['x'])) {
      const result = normalizeNode(shown, plain, targetType);
      if (!('node' in result) || matches.some((known) => known.match.entityType === result.node.ref.entityType && known.match.stableId === result.node.ref.stableId)) continue;
      const hops = row['hops'] === 2 ? 2 : 1;
      const middle = nodesIn(row['mid'])[0];
      const through = hops === 2 && middle !== undefined ? refOf(shown, middle) : undefined;
      matches.push({ match: result.node.ref, hops, ...(through === undefined ? {} : { through }) });
    }
    for (const plain of nodesIn(row['heavy'])) {
      const ref = refOf(shown, plain);
      if (ref !== undefined && !supernodes.some((known) => known.entityType === ref.entityType && known.stableId === ref.stableId)) supernodes.push(ref);
    }
  }
  return {
    ...normalized,
    matches,
    anchorFound: rows.length > 0,
    bounded: rows.some((row) => row['bounded'] === true),
    stopListed: rows.some((row) => row['stopListed'] === true),
    supernodes,
  };
}
