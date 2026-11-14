import type { EdgeRef, ElementRef, GraphEdge, GraphNode } from '@neburyx/contracts';

/** What names a node in a sentence: its title as the result has it, or its stable ID when the title is empty. No property is read. */
export function nodeTitle(node: GraphNode): string {
  return node.display.title.trim() === '' ? node.ref.stableId : node.display.title;
}

const sorted = (value: unknown): unknown => (Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, inner]) => [key, sorted(inner)])) : value);

/** A string that is equal for equal references, node or relationship, whatever the order of their fields. */
export function refId(ref: ElementRef | EdgeRef): string {
  return JSON.stringify(sorted(ref));
}

/** The title of an end of a relationship: the title of a listed node, or the stable ID of the reference when the result lists no node for it. */
export function endTitle(ref: ElementRef, nodes: ReadonlyMap<string, GraphNode>): string {
  const node = nodes.get(refId(ref));
  return node === undefined ? ref.stableId : nodeTitle(node);
}

/** The title of a relationship: its type with the titles of its two ends. */
export function edgeTitle(edge: GraphEdge, nodes: ReadonlyMap<string, GraphNode>): string {
  return `${edge.type}: ${endTitle(edge.from, nodes)} → ${endTitle(edge.to, nodes)}`;
}
