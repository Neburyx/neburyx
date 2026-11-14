import type { EdgeRef, ElementRef, GraphEdge, GraphNode } from '@neburyx/contracts';
import type { Listed } from './core.js';
import { edgeTitle, nodeTitle, refId } from './title.js';

/** How many elements a sentence names. */
export const SHOWN_NAMES = 5;

export const nodeMap = (nodes: readonly GraphNode[]): Map<string, GraphNode> => new Map(nodes.map((node) => [refId(node.ref), node]));

export const nodeItem = (node: GraphNode): Listed => ({ element: node.ref, type: node.display.type, title: nodeTitle(node) });

export const edgeItem = (edge: GraphEdge, nodes: ReadonlyMap<string, GraphNode>): Listed => ({ element: edge.ref, type: edge.type, title: edgeTitle(edge, nodes) });

/** The anchor of a result that names it by reference: the title of the node the result lists for it, or its stable ID. */
export function anchorItem(ref: ElementRef, nodes: ReadonlyMap<string, GraphNode>): Listed {
  const node = nodes.get(refId(ref));
  return node === undefined ? { element: ref, type: ref.entityType, title: ref.stableId } : nodeItem(node);
}

const refOf = (item: Listed): ElementRef | EdgeRef => item.element;

/** "A", "A and B", "A, B and C". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);
