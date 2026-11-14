import type { ElementRef, GraphEdge } from '@neburyx/contracts';
import { normalizeRows, type Normalized, type NormalizeContext } from './index.js';
import { isPlainRelationship, type PlainRelationship } from './edge.js';
import { isPlainNode, normalizeNodeAs, type PlainNode } from './node.js';

/** One step of a path in the order it is walked: the entities it joins, the relationship's type, the stable ID the mapping's row reads from it (none for an aggregate relationship) and its evidence references. */
export interface FoundStep {
  readonly from: ElementRef;
  readonly to: ElementRef;
  readonly relationshipType: string;
  readonly stableId?: string;
  readonly evidenceRefs: readonly string[];
}

/** A shortest-paths run, normalized: the nodes and edges of every path, the paths whose every entity and relationship could be normalized, and whether each end was found. */
export interface NormalizedPaths extends Normalized {
  readonly paths: readonly (readonly FoundStep[])[];
  readonly fromFound: boolean;
  readonly toFound: boolean;
}

export function isNormalizedPaths(item: unknown): item is NormalizedPaths {
  if (typeof item !== 'object' || item === null) return false;
  return 'nodes' in item && Array.isArray(item.nodes) && 'edges' in item && Array.isArray(item.edges) && 'warnings' in item && Array.isArray(item.warnings) && 'paths' in item && Array.isArray(item.paths) && 'fromFound' in item && 'toFound' in item;
}

interface PlainPath {
  readonly start: unknown;
  readonly segments: readonly { readonly relationship: unknown; readonly end: unknown }[];
}

function isPlainPath(value: unknown): value is PlainPath {
  return typeof value === 'object' && value !== null && '$type' in value && value.$type === 'path' && 'segments' in value && Array.isArray(value.segments);
}

const nodesIn = (value: unknown): readonly PlainNode[] => (Array.isArray(value) ? value : [value]).filter(isPlainNode);

function endTypesOf(params: Readonly<Record<string, unknown>> | undefined): readonly [string, string] | undefined {
  const ends = params?.['ends'];
  if (!Array.isArray(ends) || ends.length !== 2) return undefined;
  const [from, to] = ends.map((end: unknown) => (typeof end === 'object' && end !== null && 'entityType' in end && typeof end.entityType === 'string' ? end.entityType : undefined));
  return from === undefined || to === undefined ? undefined : [from, to];
}

function refOf(context: NormalizeContext, plain: PlainNode, type: string | undefined): ElementRef | undefined {
  const [result] = normalizeNodeAs(context, plain, type === undefined ? undefined : [type]);
  return result !== undefined && 'node' in result ? result.node.ref : undefined;
}

const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : undefined);

const sameRef = (left: ElementRef, right: ElementRef): boolean => left.entityType === right.entityType && left.stableId === right.stableId;

/** The evidence references of the edge a step is: the stored one with its stable ID, or the aggregate of its type between the same ends. */
function evidenceOf(edges: readonly GraphEdge[], type: string, start: ElementRef, end: ElementRef, stableId: string | undefined): readonly string[] {
  const edge = edges.find((candidate) => candidate.type === type && sameRef(candidate.from, start) && sameRef(candidate.to, end) && (stableId === undefined || ('stableId' in candidate.ref && candidate.ref.stableId === stableId)));
  return edge?.evidenceRefs ?? [];
}

function stepOf(context: NormalizeContext, edges: readonly GraphEdge[], relationship: PlainRelationship, near: { readonly plain: PlainNode; readonly ref: ElementRef }, far: { readonly plain: PlainNode; readonly ref: ElementRef }): FoundStep | undefined {
  const forward = relationship.startElementId === near.plain.elementId;
  const [start, end] = forward ? [near.ref, far.ref] : [far.ref, near.ref];
  const row = context.model.relationships.find((candidate) => candidate.type === relationship.type && candidate.from === start.entityType && candidate.to === end.entityType);
  if (row === undefined) return undefined;
  const stableId = row.stableId === undefined || !Object.hasOwn(relationship.properties, row.stableId) ? undefined : textOf(relationship.properties[row.stableId]);
  if (row.stableId !== undefined && stableId === undefined) return undefined;
  return { from: near.ref, to: far.ref, relationshipType: relationship.type, ...(stableId === undefined ? {} : { stableId }), evidenceRefs: evidenceOf(edges, relationship.type, start, end, stableId) };
}

function pathOf(context: NormalizeContext, edges: readonly GraphEdge[], path: PlainPath, ends: readonly [string, string]): readonly FoundStep[] | undefined {
  const nodes = [path.start, ...path.segments.map((segment) => segment.end)];
  const walked = nodes.map((value, position) => {
    if (!isPlainNode(value)) return undefined;
    const ref = refOf(context, value, position === 0 ? ends[0] : position === nodes.length - 1 ? ends[1] : undefined);
    return ref === undefined ? undefined : { plain: value, ref };
  });
  const steps: FoundStep[] = [];
  for (const [position, segment] of path.segments.entries()) {
    const [near, far] = [walked[position], walked[position + 1]];
    if (near === undefined || far === undefined || !isPlainRelationship(segment.relationship)) return undefined;
    const step = stepOf(context, edges, segment.relationship, near, far);
    if (step === undefined) return undefined;
    steps.push(step);
  }
  return steps.length === 0 ? undefined : steps;
}

const keyOf = (steps: readonly FoundStep[]): string => steps.map((step) => step.stableId ?? step.to.stableId).join('\u0000');

/**
 * The nodes and edges of the rows of a shortest-paths read, the two ends read as the types the request named, and the paths whose every entity and relationship could be normalized, ordered by hops and then by the stable
 * IDs of their steps. A path that crosses an entity or a relationship the mapping does not describe, or that has no usable stable ID, is left out; the elements left out are counted by reason, as for every read.
 */
export function normalizeShortestPaths(context: NormalizeContext, rows: readonly Readonly<Record<string, unknown>>[]): NormalizedPaths {
  const ends = endTypesOf(context.params);
  if (ends === undefined) return { ...normalizeRows(context, []), paths: [], fromFound: false, toFound: false };
  const expected = new Map<string, readonly string[]>();
  for (const row of rows) {
    for (const plain of nodesIn(row['a'])) expected.set(plain.elementId, [ends[0]]);
    for (const plain of nodesIn(row['b'])) expected.set(plain.elementId, [...new Set([...(expected.get(plain.elementId) ?? []), ends[1]])]);
  }
  const normalized = normalizeRows(context, rows, expected);
  const found = rows.flatMap((row) => (isPlainPath(row['p']) ? [row['p']] : [])).flatMap((path) => {
    const steps = pathOf(context, normalized.edges, path, ends);
    return steps === undefined ? [] : [steps];
  });
  const paths = found.sort((left, right) => left.length - right.length || keyOf(left).localeCompare(keyOf(right)));
  return { ...normalized, paths, fromFound: rows.length > 0, toFound: rows.some((row) => isPlainNode(row['b'])) };
}
