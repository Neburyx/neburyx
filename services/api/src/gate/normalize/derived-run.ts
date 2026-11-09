import type { EdgeRef, ElementRef, GraphEdge } from '@neburyx/contracts';
import { withDerivedEdges, type DerivedClaim } from './derived.js';
import { warningsOf } from './drops.js';
import { isPlainRelationship, type PlainRelationship } from './edge.js';
import { normalizeRows, type Normalized, type NormalizeContext } from './index.js';
import { isPlainNode, normalizeNode, type PlainNode } from './node.js';

interface PlainPath {
  readonly start: PlainNode;
  readonly segments: readonly { readonly relationship: PlainRelationship; readonly end: PlainNode }[];
}

function pathOf(row: Readonly<Record<string, unknown>>): PlainPath | undefined {
  const value = row['p'];
  if (typeof value !== 'object' || value === null || !('start' in value) || !('segments' in value) || !Array.isArray(value.segments)) return undefined;
  if (!isPlainNode(value.start)) return undefined;
  const segments = value.segments.flatMap((segment: unknown) => {
    if (typeof segment !== 'object' || segment === null || !('relationship' in segment) || !('end' in segment)) return [];
    return isPlainRelationship(segment.relationship) && isPlainNode(segment.end) ? [{ relationship: segment.relationship, end: segment.end }] : [];
  });
  return { start: value.start, segments };
}

const sameEntity = (left: ElementRef, right: ElementRef): boolean => left.entityType === right.entityType && left.stableId === right.stableId;

function typeOf(edge: GraphEdge): string {
  return 'aggregate' in edge.ref ? edge.ref.aggregate.type : edge.type;
}

function joins(edge: GraphEdge, one: ElementRef, other: ElementRef): boolean {
  return (sameEntity(edge.from, one) && sameEntity(edge.to, other)) || (sameEntity(edge.from, other) && sameEntity(edge.to, one));
}

/** The entity type of each node of a path, in order, from the rule: its `from`, the middle entity types of the chain, and its `to`. */
function typesOf(via: readonly string[], from: string, to: string): readonly string[] {
  return [from, ...via.filter((_entry, index) => index % 2 === 1), to];
}

/**
 * The claim of one path: the rule, the two ends and the supporting edges in chain order, each found among the edges that this one path normalizes to (so a stored support is the relationship the path followed,
 * and an aggregate is the one of its type and ends). A path with a node or a relationship the normalizer left out has no claim.
 */
function claimOf(context: NormalizeContext, ruleId: string, types: readonly string[], path: PlainPath, edges: readonly GraphEdge[]): DerivedClaim | undefined {
  const nodes = [path.start, ...path.segments.map((segment) => segment.end)];
  const refs: ElementRef[] = [];
  for (const [index, plain] of nodes.entries()) {
    const result = normalizeNode(context, plain, types[index]);
    if (!('node' in result)) return undefined;
    refs.push(result.node.ref);
  }
  const supports: EdgeRef[] = [];
  for (const [index, segment] of path.segments.entries()) {
    const before = refs[index];
    const after = refs[index + 1];
    const edge = before === undefined || after === undefined ? undefined : edges.find((candidate) => typeOf(candidate) === segment.relationship.type && joins(candidate, before, after));
    if (edge === undefined) return undefined;
    supports.push(edge.ref);
  }
  const from = refs[0];
  const to = refs[refs.length - 1];
  return from === undefined || to === undefined ? undefined : { ruleId, from, to, supports };
}

function expectedOf(paths: readonly PlainPath[], types: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const expected = new Map<string, readonly string[]>();
  for (const path of paths) {
    const nodes = [path.start, ...path.segments.map((segment) => segment.end)];
    for (const [index, node] of nodes.entries()) {
      const type = types[index];
      if (type !== undefined) expected.set(node.elementId, [...new Set([...(expected.get(node.elementId) ?? []), type])]);
    }
  }
  return expected;
}

/**
 * The derived edges of a rule run: the nodes and edges of every path, then one derived edge for each path that follows the rule of the mapping with supports that are edges of the result. A path shows one member of a
 * relationship type with no stable ID, so its aggregate edge is always a lower bound. A path the normalizer cannot account for gives no edge and is counted as not mapped.
 */
export function normalizeDerivedRun(context: NormalizeContext, rows: readonly Readonly<Record<string, unknown>>[]): Normalized {
  const rule = context.model.derived.find((candidate) => candidate.id === context.params?.['ruleId']);
  if (rule === undefined) return normalizeRows(context, []);
  const shown = { ...context, hasMore: true };
  const types = typesOf(rule.via, rule.from, rule.to);
  const found = rows.flatMap((row) => {
    const path = pathOf(row);
    return path === undefined ? [] : [{ row, path }];
  });
  const normalized = normalizeRows(shown, rows, expectedOf(found.map((entry) => entry.path), types));
  const claims: DerivedClaim[] = [];
  let lost = 0;
  for (const { row, path } of found) {
    const alone = normalizeRows(shown, [row], expectedOf([path], types));
    const claim = claimOf(shown, rule.id, types, path, alone.edges);
    if (claim === undefined) lost += 1;
    else claims.push(claim);
  }
  const result = withDerivedEdges(shown, normalized, claims);
  if (lost === 0) return result;
  const dropped = { ...result.dropped, 'not-mapped': result.dropped['not-mapped'] + lost };
  return { ...result, dropped, warnings: warningsOf(dropped, result.unreferenced.length) };
}
