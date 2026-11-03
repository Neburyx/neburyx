import type { GraphEdge, GraphNode } from '@neburyx/contracts';
import { mergeNode, nodeKey } from './dedupe.js';
import { isPlainRelationship, normalizeEdges, type NodeOutcome, type PlainRelationship } from './edge.js';
import { noDrops, warningsOf, type Dropped } from './drops.js';
import type { NormalizeContext } from './model.js';
import { isPlainNode, normalizeNode, type PlainNode } from './node.js';

export { withDerivedEdges, type DerivedClaim } from './derived.js';
export { EMPTY_MODEL, normalizeModelOf } from './model.js';
export type { NormalizeContext, NormalizeModel } from './model.js';

/** What normalizing the rows of one read gives: the nodes and edges of the source's model, the rows left out by reason, and one sentence for each reason. */
export interface Normalized {
  readonly nodes: GraphNode[];
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

/** The graph values of the rows in the order they appear, each node and each relationship once (by element ID), a list of values flattened. */
function graphValuesOf(rows: readonly Readonly<Record<string, unknown>>[]): { readonly nodes: PlainNode[]; readonly relationships: PlainRelationship[] } {
  const nodes = new Map<string, PlainNode>();
  const relationships = new Map<string, PlainRelationship>();
  for (const row of rows) {
    for (const value of Object.values(row).flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))) {
      // a path is its start node, then the relationship and the node of each segment, in the order of the path
      for (const part of isPlainPath(value) ? [value.start, ...value.segments.flatMap((segment) => [segment.relationship, segment.end])] : [value]) {
        if (isPlainNode(part) && !nodes.has(part.elementId)) nodes.set(part.elementId, part);
        else if (isPlainRelationship(part) && !relationships.has(part.elementId)) relationships.set(part.elementId, part);
      }
    }
  }
  return { nodes: [...nodes.values()], relationships: [...relationships.values()] };
}

export function normalizeRows(context: NormalizeContext, rows: readonly Readonly<Record<string, unknown>>[]): Normalized {
  const found = graphValuesOf(rows);
  const nodes = new Map<string, GraphNode>();
  const outcomes = new Map<string, NodeOutcome>();
  const dropped = noDrops();
  for (const plain of found.nodes) {
    const result = normalizeNode(context, plain);
    if ('node' in result) {
      const key = nodeKey(result.node);
      const known = nodes.get(key);
      nodes.set(key, known === undefined ? result.node : mergeNode(known, result.node));
      outcomes.set(plain.elementId, { ref: result.node.ref });
    } else {
      dropped[result.dropped] += 1;
      outcomes.set(plain.elementId, { dropped: result.dropped });
    }
  }
  const edges = normalizeEdges(context, found.relationships, outcomes);
  for (const reason of edges.dropped) dropped[reason] += 1;
  return { nodes: [...nodes.values()], edges: edges.edges, dropped, warnings: warningsOf(dropped) };
}
