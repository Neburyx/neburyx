import type { ElementRef } from '@neburyx/contracts';
import { normalizeRows, type Normalized, type NormalizeContext } from './index.js';
import { isPlainRelationship, type PlainRelationship } from './edge.js';
import { isPlainNode, normalizeNode, normalizeNodeAs, type PlainNode } from './node.js';

/** One hop of the shown path of a match: the relationship's type, the entities it joins as stored (its start, then its end) and its stable ID when the mapping's row for it has one (an aggregate edge has none). */
export interface PatternHop {
  readonly relationshipType: string;
  /** `null` for an end that has no usable stable ID (counted by reason), so that the path keeps its positions. */
  readonly from: ElementRef | null;
  readonly to: ElementRef | null;
  readonly stableId?: string;
}

/** One match of a pattern run: the entity the last step reached, the entities between in order, and the relationship of each hop of the shown path. */
export interface PatternMatch {
  readonly match: ElementRef;
  /** The number of steps of the path: 1 to the pattern's step count. */
  readonly hops: number;
  /** The entities between, in order: `hops − 1` of them, `null` at the place of one with no usable stable ID (counted by reason, as for every read). */
  readonly through: readonly (ElementRef | null)[];
  /** The relationship of each hop of the shown path, one for each hop, in order; the edges themselves are in the result's edges. */
  readonly relationships: readonly PatternHop[];
}

/** A pattern run, normalized: the nodes and edges of every row, the matches with their paths, the supernodes that were not traversed, and the flags the read raised. */
export interface NormalizedPattern extends Normalized {
  readonly matches: readonly PatternMatch[];
  /** The read found the anchor: it answered at least one row, even one with no match. */
  readonly anchorFound: boolean;
  /** A bound of the read (the nodes a step reached) was hit, so there may be more matches. */
  readonly bounded: boolean;
  /** An entity on a stop-list was not traversed. */
  readonly stopListed: boolean;
  /** Entities with more relationships than the count cap, which were not traversed, at most the request's limit of them. */
  readonly supernodes: readonly ElementRef[];
}

export function isNormalizedPattern(item: unknown): item is NormalizedPattern {
  if (typeof item !== 'object' || item === null) return false;
  return 'nodes' in item && Array.isArray(item.nodes) && 'edges' in item && Array.isArray(item.edges) && 'warnings' in item && Array.isArray(item.warnings) && 'matches' in item && Array.isArray(item.matches) && 'supernodes' in item && Array.isArray(item.supernodes) && 'anchorFound' in item;
}

const nodesIn = (value: unknown): readonly PlainNode[] => (Array.isArray(value) ? value : [value]).filter(isPlainNode);

function refOf(context: NormalizeContext, plain: PlainNode, type?: string): ElementRef | undefined {
  const [result] = normalizeNodeAs(context, plain, type === undefined ? undefined : [type]);
  return result !== undefined && 'node' in result ? result.node.ref : undefined;
}

/** The entity types of the steps, in order, from the parameters the run was given: the type each step arrives at. */
function arrivalTypesOf(params: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  const steps = params?.['steps'];
  if (!Array.isArray(steps)) return [];
  return steps.map((step: unknown) => (typeof step === 'object' && step !== null && 'arrivesAt' in step && typeof step.arrivesAt === 'string' ? step.arrivesAt : ''));
}

/**
 * The nodes and edges of the rows of a pattern read: the anchor, the entities between and the matches read as the types the request named, the supernodes as the type their labels give, and the matches with their paths. A match
 * with no usable stable ID is left out and counted by reason, as for every read.
 */
export function normalizePattern(context: NormalizeContext, rows: readonly Readonly<Record<string, unknown>>[]): NormalizedPattern {
  const anchorType = context.params?.['anchorType'];
  const arrivals = arrivalTypesOf(context.params);
  const empty = { matches: [], anchorFound: false, bounded: false, stopListed: false, supernodes: [] };
  if (typeof anchorType !== 'string' || arrivals.length === 0 || arrivals.some((type) => type === '')) return { ...normalizeRows(context, []), ...empty };
  const shown = { ...context, hasMore: context.hasMore || rows.some((row) => row['bounded'] === true || row['membersCut'] === true) };
  const expected = new Map<string, readonly string[]>();
  const expect = (plain: PlainNode, type: string): void => void expected.set(plain.elementId, [...new Set([...(expected.get(plain.elementId) ?? []), type])]);
  const last = arrivals[arrivals.length - 1] ?? '';
  for (const row of rows) {
    for (const plain of nodesIn(row['a'])) expect(plain, anchorType);
    for (const plain of nodesIn(row['x'])) expect(plain, last);
    nodesIn(row['mid']).forEach((plain, position) => expect(plain, arrivals[position] ?? ''));
  }
  const normalized = normalizeRows(shown, rows, expected);
  const matches: PatternMatch[] = [];
  const supernodes: ElementRef[] = [];
  for (const row of rows) {
    for (const plain of nodesIn(row['x'])) {
      const result = normalizeNode(shown, plain, last);
      if (!('node' in result) || matches.some((known) => known.match.entityType === result.node.ref.entityType && known.match.stableId === result.node.ref.stableId)) continue;
      const between = nodesIn(row['mid']).map((middle, position) => refOf(shown, middle, arrivals[position]) ?? null);
      const hops = arrivals.length;
      const path = [nodesIn(row['a'])[0], ...nodesIn(row['mid']), plain].map((node, position) => ({ node, type: position === 0 ? anchorType : arrivals[position - 1] }));
      const relationships = Array.from({ length: hops }, (_unused, position) => hopOf(shown, row[`r${position + 1}`], path, position));
      matches.push({ match: result.node.ref, hops, through: between, relationships });
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

const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : undefined);

/** The hop a relationship of the shown path is, at its position: its type, the entities it joins as stored and the stable ID the mapping's row for it reads from it. */
function hopOf(context: NormalizeContext, value: unknown, path: readonly { readonly node: PlainNode | undefined; readonly type: string | undefined }[], position: number): PatternHop {
  const [near, far] = [path[position], path[position + 1]];
  if (!isPlainRelationship(value) || near?.node === undefined || far?.node === undefined) return { relationshipType: '', from: null, to: null };
  const forward = value.startElementId === near.node.elementId;
  const [start, end] = forward ? [near, far] : [far, near];
  const [from, to] = [start.node === undefined ? null : (refOf(context, start.node, start.type) ?? null), end.node === undefined ? null : (refOf(context, end.node, end.type) ?? null)];
  const row = context.model.relationships.find((candidate) => candidate.type === value.type && candidate.from === start.type && candidate.to === end.type);
  const stableId = row?.stableId === undefined ? undefined : textOf(ownProperty(value, row.stableId));
  return { relationshipType: value.type, from, to, ...(stableId === undefined ? {} : { stableId }) };
}

const ownProperty = (relationship: PlainRelationship, name: string): unknown => (Object.hasOwn(relationship.properties, name) ? relationship.properties[name] : undefined);
