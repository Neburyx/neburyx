import type { ElementRef, GraphEdge, GraphNode } from '@neburyx/contracts';
import { mergeNode, nodeKey } from './dedupe.js';
import { isPlainRelationship, normalizeEdges, summarizedAggregate, type EdgeDirection, type NodeOutcome, type PlainRelationship } from './edge.js';
import { noDrops, warningsOf, type Dropped } from './drops.js';
import type { NormalizeContext } from './model.js';
import { isPlainNode, normalizeNode, type PlainNode } from './node.js';
import type { Normalized } from './index.js';

/** The phases of an expansion's rows (see `expand-statement.ts`): which of them are aggregates. */
const AGGREGATE_PHASES: ReadonlySet<number> = new Set([1, 3]);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A page of an expansion: the nodes and edges of the source's model, the rows left out by reason, and the facts the service needs. */
export interface ExpansionPage extends Normalized {
  /** False when the anchor node was not found. */
  readonly anchorFound: boolean;
  /** The edges of the page. */
  readonly returned: number;
}

interface ExpansionRow {
  readonly phase: number;
  readonly dir: 'out' | 'in';
  readonly rtype: string;
  readonly members: unknown;
  readonly first: unknown;
  readonly last: unknown;
  readonly flag: string | null;
  readonly relationship: PlainRelationship | undefined;
  readonly neighbor: PlainNode;
}

function rowOf(row: Readonly<Record<string, unknown>>): ExpansionRow | undefined {
  const { phase, dir, rtype, flag, rel, m } = row;
  if (typeof phase !== 'number' || (dir !== 'out' && dir !== 'in') || typeof rtype !== 'string' || !isPlainNode(m)) return undefined;
  return { phase, dir, rtype, members: row['members'], first: row['first'], last: row['ts'], flag: typeof flag === 'string' ? flag : null, relationship: isPlainRelationship(rel) ? rel : undefined, neighbor: m };
}

function outcomesOf(context: NormalizeContext, plains: readonly PlainNode[], expected: ReadonlyMap<string, string>): { readonly outcomes: Map<string, NodeOutcome>; readonly nodes: GraphNode[]; readonly dropped: Dropped } {
  const outcomes = new Map<string, NodeOutcome>();
  const nodes = new Map<string, GraphNode>();
  const dropped = noDrops();
  for (const plain of plains) {
    if (outcomes.has(plain.elementId)) continue;
    const result = normalizeNode(context, plain, expected.get(plain.elementId));
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
  return { outcomes, nodes: [...nodes.values()], dropped };
}

const memberCountOf = (members: unknown): number => (typeof members === 'number' && Number.isSafeInteger(members) && members > 0 ? members : 1);

/**
 * The page of one neighbor type of an expansion. A stored row carries a relationship and both ends; an aggregate row carries the neighbor and the summary of every member of its pair, so no row is
 * separated from an end by a page boundary. Each row is accounted for exactly once: a stored edge, a stored duplicate folded into a flagged edge, an aggregate edge, or a count under a named reason
 * (an aggregate row counts its members).
 */
export function normalizeExpansion(context: NormalizeContext, rows: readonly Readonly<Record<string, unknown>>[]): ExpansionPage {
  const anchor = rows.map((row) => row['a']).find(isPlainNode);
  const anchorType = context.params?.['entityType'];
  const neighborType = context.params?.['neighborType'];
  const expected = new Map<string, string>();
  if (anchor !== undefined && typeof anchorType === 'string') expected.set(anchor.elementId, anchorType);
  const data = rows.flatMap((row) => {
    const read = rowOf(row);
    return read === undefined ? [] : [read];
  });
  if (typeof neighborType === 'string') for (const row of data) if (!expected.has(row.neighbor.elementId)) expected.set(row.neighbor.elementId, neighborType);
  const { outcomes, nodes, dropped } = outcomesOf(context, [...(anchor === undefined ? [] : [anchor]), ...data.map((row) => row.neighbor)], expected);
  const rankOfRelationship = new Map(data.flatMap((row, rank) => (row.relationship === undefined ? [] : [[row.relationship.elementId, rank] as const])));
  const directions = new Map(data.flatMap((row) => (row.relationship === undefined ? [] : [[row.relationship.elementId, row.dir] as const])));
  const stored = normalizeEdges(
    context,
    data.flatMap((row) => (row.relationship === undefined ? [] : [row.relationship])),
    outcomes,
    (relationship): EdgeDirection => directions.get(relationship.elementId) ?? 'from-to',
  );
  const ranked: { readonly rank: number; readonly edge: GraphEdge }[] = stored.edges.map((edge, index) => ({ rank: rankOfRelationship.get(stored.firstElementIds[index] ?? '') ?? 0, edge }));
  for (const reason of stored.dropped) dropped[reason] = (dropped[reason] ?? 0) + 1;
  const anchorOutcome = anchor === undefined ? undefined : outcomes.get(anchor.elementId);
  data.forEach((row, rank) => {
    if (!AGGREGATE_PHASES.has(row.phase)) return;
    const members = memberCountOf(row.members);
    const neighbor = outcomes.get(row.neighbor.elementId);
    if (anchorOutcome === undefined || neighbor === undefined) {
      dropped['end-missing'] = (dropped['end-missing'] ?? 0) + members;
      return;
    }
    if ('dropped' in anchorOutcome || 'dropped' in neighbor) {
      dropped['end-not-shown'] = (dropped['end-not-shown'] ?? 0) + members;
      return;
    }
    const ends: { readonly from: ElementRef; readonly to: ElementRef } = row.dir === 'out' ? { from: anchorOutcome.ref, to: neighbor.ref } : { from: neighbor.ref, to: anchorOutcome.ref };
    ranked.push({ rank, edge: summarizedAggregate(context, { type: row.rtype, ...ends, members: row.members, first: row.first, last: row.last, direction: row.dir, flags: row.flag === null ? [] : [row.flag] }) });
  });
  const edges = ranked.sort((left, right) => left.rank - right.rank).map((entry) => entry.edge);
  return { nodes, unreferenced: [], edges, dropped, warnings: warningsOf(dropped), anchorFound: anchor !== undefined && isObject(anchor), returned: edges.length };
}
