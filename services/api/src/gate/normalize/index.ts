import type { GraphEdge, GraphNode, UnreferencedHit } from '@neburyx/contracts';
import { mergeNode, nodeKey } from './dedupe.js';
import { isPlainRelationship, normalizeEdges, type NodeOutcome, type PlainRelationship, type RelationshipEvidence } from './edge.js';
import { noDrops, warningsOf, type Dropped } from './drops.js';
import type { NormalizeContext } from './model.js';
import { isPlainNode, normalizeNodeAs, type PlainNode } from './node.js';

export { withDerivedEdges, type DerivedClaim } from './derived.js';
export { EMPTY_MODEL, normalizeModelOf } from './model.js';
export type { NormalizeContext, NormalizeModel } from './model.js';
export type { RelationshipEvidence } from './edge.js';

/**
 * What normalizing the rows of one read gives: the nodes and edges of the source's model, the records of a mapped type with no usable stable ID (listed, never referenced; also counted as
 * `no-stable-id`), the rows left out by reason, and one sentence for each reason.
 */
export interface Normalized {
  readonly nodes: GraphNode[];
  readonly unreferenced: UnreferencedHit[];
  readonly edges: GraphEdge[];
  readonly dropped: Dropped;
  readonly warnings: string[];
}

interface PlainPath {
  readonly $type: 'path';
  readonly start: unknown;
  readonly segments: readonly { readonly relationship: unknown; readonly end: unknown }[];
}

function isPlainPath(value: unknown): value is PlainPath {
  return typeof value === 'object' && value !== null && (value as { $type?: unknown }).$type === 'path' && Array.isArray((value as { segments?: unknown }).segments);
}

/** The entity types a read asked for the record in one column of a row, when the read names them; see `expectedTypesOf`. */
export type AskedTypesOf = (row: Readonly<Record<string, unknown>>, column: string) => readonly string[] | undefined;

/** The values of one column of a row in order: a list flattened, and a path as its start node, then the relationship and the node of each segment. */
function partsOf(entry: unknown): unknown[] {
  return (Array.isArray(entry) ? entry : [entry]).flatMap((value: unknown) => (isPlainPath(value) ? [value.start, ...value.segments.flatMap((segment) => [segment.relationship, segment.end])] : [value]));
}

/** The graph values of the rows in the order they appear, each node and each relationship once (by element ID). */
function graphValuesOf(rows: readonly Readonly<Record<string, unknown>>[]): { readonly nodes: PlainNode[]; readonly relationships: PlainRelationship[] } {
  const nodes = new Map<string, PlainNode>();
  const relationships = new Map<string, PlainRelationship>();
  for (const row of rows) {
    for (const part of Object.values(row).flatMap(partsOf)) {
      if (isPlainNode(part) && !nodes.has(part.elementId)) nodes.set(part.elementId, part);
      else if (isPlainRelationship(part) && !relationships.has(part.elementId)) relationships.set(part.elementId, part);
    }
  }
  return { nodes: [...nodes.values()], relationships: [...relationships.values()] };
}

/** The entity types asked for each node of the rows, by element ID: every type `askedOf` names for a column the node is in, across all its rows. */
export function expectedTypesOf(rows: readonly Readonly<Record<string, unknown>>[], askedOf: AskedTypesOf): Map<string, readonly string[]> {
  const expected = new Map<string, readonly string[]>();
  for (const row of rows) {
    for (const [column, entry] of Object.entries(row)) {
      const asked = askedOf(row, column);
      if (asked === undefined) continue;
      for (const part of partsOf(entry)) if (isPlainNode(part)) expected.set(part.elementId, [...new Set([...(expected.get(part.elementId) ?? []), ...asked])]);
    }
  }
  return expected;
}

/**
 * The nodes, unreferenced records and edges of the rows. `expected` gives, by element ID, the entity types a node was read as (a read that names its types), which settle a node whose labels match
 * several types; a node expected as two of its types is a node of each. A node whose labels match several types and that is expected as none of them is left out as `ambiguous-type`.
 */
export function normalizeRows(context: NormalizeContext, rows: readonly Readonly<Record<string, unknown>>[], expected: ReadonlyMap<string, readonly string[]> = new Map()): Normalized {
  const { nodes, unreferenced, edges, dropped, warnings } = normalizeWithEvidence(context, rows, expected);
  return { nodes, unreferenced, edges, dropped, warnings };
}

/** What normalizing the rows of an evidence read gives: the normalized result and the evidence of each relationship of its edges, in the order they were read. */
export interface NormalizedEvidence extends Normalized {
  readonly evidence: RelationshipEvidence[];
}

export function isNormalizedEvidence(item: Normalized): item is NormalizedEvidence {
  return 'evidence' in item && Array.isArray(item.evidence);
}

/** `normalizeRows`, with the evidence of each relationship of the edges beside the result, for the evidence search. */
export function normalizeWithEvidence(context: NormalizeContext, rows: readonly Readonly<Record<string, unknown>>[], expected: ReadonlyMap<string, readonly string[]> = new Map()): NormalizedEvidence {
  const found = graphValuesOf(rows);
  const nodes = new Map<string, GraphNode>();
  const unreferenced: UnreferencedHit[] = [];
  const outcomes = new Map<string, NodeOutcome>();
  const dropped = noDrops();
  for (const plain of found.nodes) {
    let outcome: NodeOutcome | undefined;
    for (const result of normalizeNodeAs(context, plain, expected.get(plain.elementId))) {
      if ('node' in result) {
        const key = nodeKey(result.node);
        const known = nodes.get(key);
        nodes.set(key, known === undefined ? result.node : mergeNode(known, result.node));
        outcome ??= { ref: result.node.ref };
      } else if ('unreferenced' in result) {
        unreferenced.push(result.unreferenced);
        dropped['no-stable-id'] += 1;
      } else {
        dropped[result.dropped] = (dropped[result.dropped] ?? 0) + 1;
        outcome ??= { dropped: result.dropped };
      }
    }
    // an edge to a record with no usable stable ID has no end to point at, so it is left out
    outcomes.set(plain.elementId, outcome ?? { dropped: 'no-stable-id' });
  }
  const edges = normalizeEdges(context, found.relationships, outcomes);
  for (const reason of edges.dropped) dropped[reason] = (dropped[reason] ?? 0) + 1;
  return { nodes: [...nodes.values()], unreferenced, edges: edges.edges, dropped, warnings: warningsOf(dropped, unreferenced.length), evidence: edges.evidence };
}
