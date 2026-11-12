import type { Count, DegreePreview, ElementRef, GraphEdge } from '@neburyx/contracts';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { endContributionOf, LOADED_SCOPE } from './loaded-ends.js';
import { formatNumber } from './scope-text.js';

const REMAINDER_SCOPE = 'not loaded';
const DIRECTIONS_SCOPE = 'in every direction';

const sameNode = (a: ElementRef, b: ElementRef): boolean => a.entityType === b.entityType && a.stableId === b.stableId;

/**
 * Adds contributions to a loaded count: the sum of their values, and its quality is estimated when any contribution is estimated (a mix of lower-bound and estimated counts promises neither a floor nor a figure), else a lower bound when any
 * is a lower bound or has no value (those count the members known, plus one for a count with none), else exact.
 */
export function sumOf(contributions: readonly Count[]): Count {
  let value = 0;
  let estimated = false;
  let bound = false;
  for (const part of contributions) {
    if (part.value === undefined) {
      value += 1;
      bound = true;
    } else {
      value += part.value;
      if (part.quality === 'estimated') estimated = true;
      else if (part.quality !== 'exact') bound = true;
    }
  }
  return { value, quality: estimated ? 'estimated' : bound ? 'lowerBound' : 'exact', scope: LOADED_SCOPE };
}

export interface LoadedByType {
  /** The stored relationships of the node in the loaded graph, by the entity type at their other end: each plain relationship once, an aggregate by its member count. Derived and unknown-origin relationships are not counted: a degree preview does not count them. */
  readonly byType: ReadonlyMap<string, Count>;
  readonly total: Count;
}

export function loadedOf(graph: LoadedGraph, node: ElementRef): LoadedByType {
  const parts = new Map<string, Count[]>();
  const all: Count[] = [];
  for (const edge of graph.edges) {
    const fromHere = sameNode(edge.from, node);
    const toHere = sameNode(edge.to, node);
    if (!fromHere && !toHere) continue;
    const other = fromHere ? edge.to : edge.from;
    const contribution = endContributionOf(edge);
    if (contribution === undefined) continue;
    const ends = fromHere && toHere ? [contribution, contribution] : [contribution];
    parts.set(other.entityType, [...(parts.get(other.entityType) ?? []), ...ends]);
    all.push(...ends);
  }
  return { byType: new Map([...parts].map(([type, held]) => [type, sumOf(held)])), total: sumOf(all) };
}

/** What is left to load: a number only where it can be named honestly (an exact total and an exact loaded count give an exact one, a lower-bound or estimated total keeps its own quality); otherwise, and when more is loaded than the total says, none. */
export function notLoadedOf(total: Count | undefined, loaded: Count): Count | undefined {
  if (total?.value === undefined || loaded.value === undefined || loaded.quality !== 'exact' || loaded.value > total.value) return undefined;
  if (total.quality !== 'exact' && total.quality !== 'lowerBound' && total.quality !== 'estimated') return undefined;
  const left = total.value - loaded.value;
  // nothing left of a lower bound or an estimate is no claim that nothing is left: only an exact total can say zero
  if (left === 0 && total.quality !== 'exact') return undefined;
  return { value: left, quality: total.quality, scope: REMAINDER_SCOPE };
}

export function loadedCountText(count: Count): string {
  const number = formatNumber(count.value ?? 0);
  return `${count.quality === 'estimated' ? '~ ' : count.quality === 'lowerBound' ? '≥ ' : ''}${number} loaded`;
}

export function notLoadedText(count: Count | undefined): string {
  if (count?.value === undefined) return 'not loaded: no count';
  const number = formatNumber(count.value);
  switch (count.quality) {
    case 'exact':
      return `${number} not loaded`;
    case 'lowerBound':
      return `≥ ${number} not loaded (lower bound)`;
    case 'estimated':
      return `~ ${number} not loaded (estimated)`;
    case 'unknown':
      return 'not loaded: no count';
    default: {
      const unreachable: never = count.quality;
      return unreachable;
    }
  }
}

/** The node does not fit one page of the source's default size: a neighbor type has a count above it, or a count that is a lower bound or unknown. No threshold of its own. */
export function isSupernode(preview: DegreePreview | undefined): boolean {
  if (preview === undefined) return false;
  return preview.byNeighborType.some(({ count }) => count.quality === 'lowerBound' || count.quality === 'unknown' || (count.value !== undefined && count.value > preview.pageSize));
}

/** A count as a number with its quality in front: "22", "~ 22", "≥ 22"; nothing for a count with no value. */
export function countNumber(count: Count): string {
  if (count.value === undefined) return '';
  const number = formatNumber(count.value);
  return count.quality === 'estimated' ? `~ ${number}` : count.quality === 'lowerBound' ? `≥ ${number}` : number;
}

/** The scope line of an entity's sourced neighbors: what is loaded of the source's total and what is not. Both numbers keep their quality; with either missing no number is drawn. */
export function scopeLineText(total: Count | undefined, loaded: Count): string {
  if (total?.value === undefined || loaded.value === undefined) return 'not loaded: no count';
  return `${countNumber(loaded)} of ${countNumber(total)} sourced neighbors on canvas · ${remainderText(total, loaded)}`;
}

const LOWER_BOUND_REASON = 'not loaded: no count while the loaded count is a lower bound';

/** The remainder when it can be named; when it cannot because the loaded count is only a floor, that is said, so the sentence does not read as a contradiction of the rows above it. */
function remainderText(total: Count, loaded: Count): string {
  const left = notLoadedOf(total, loaded);
  return left === undefined && loaded.quality === 'lowerBound' ? LOWER_BOUND_REASON : notLoadedText(left);
}

/** The counts of the same relationship type in the directions a degree preview lists, as one: no number when any has none, estimated when any is estimated, else a lower bound when any is, else exact. Nothing for none. */
export function combineDegreeCounts(counts: readonly Count[]): Count | undefined {
  if (counts.length === 0) return undefined;
  let value = 0;
  let estimated = false;
  let bound = false;
  for (const part of counts) {
    if (part.value === undefined) return { quality: 'unknown', scope: DIRECTIONS_SCOPE };
    value += part.value;
    if (part.quality === 'estimated') estimated = true;
    else if (part.quality !== 'exact') bound = true;
  }
  return { value, quality: estimated ? 'estimated' : bound ? 'lowerBound' : 'exact', scope: DIRECTIONS_SCOPE };
}

/** The stored relationships of the node in the loaded graph by relationship type, each plain relationship once and an aggregate by its member count; derived and unknown-origin relationships are not counted. */
export function loadedByRelationshipType(graph: LoadedGraph, node: ElementRef): ReadonlyMap<string, Count> {
  const parts = new Map<string, Count[]>();
  for (const edge of graph.edges) {
    if (!sameNode(edge.from, node) && !sameNode(edge.to, node)) continue;
    const contribution = endContributionOf(edge);
    if (contribution === undefined) continue;
    parts.set(edge.type, [...(parts.get(edge.type) ?? []), ...(sameNode(edge.from, node) && sameNode(edge.to, node) ? [contribution, contribution] : [contribution])]);
  }
  return new Map([...parts].map(([type, held]) => [type, sumOf(held)]));
}
