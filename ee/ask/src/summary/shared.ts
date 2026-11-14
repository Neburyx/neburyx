import type { EdgeRef, ElementRef, GraphEdge, GraphNode } from '@neburyx/contracts';
import type { Listed, SummaryBuilder } from './core.js';
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

/** A name a sentence lists, with the element a citation holds of it when the sentence cites it. */
export interface NamedItem {
  readonly title: string;
  readonly ref?: ElementRef | EdgeRef | undefined;
}

/** How a sentence reads: the names joined, how many they are (for the singular) and whether they are the whole list or only some of it. */
export type NamedSentence = (list: string, count: number, complete: boolean) => string;

/** The sizes of the lists a sentence is tried with: all the names, then three, then one. */
const retrySizes = (count: number): readonly number[] => [...new Set([count, 3, 1].filter((size) => size <= count && size >= 1))];

/**
 * Adds a sentence that lists names, citing `lead` first and then the elements of the names it lists. When the sentence would pass the length limit it is tried again with three names and then with one, always in the form that says
 * the list is not the whole of it; if even the shortest does not fit, it is added anyway so that the builder leaves it out and counts it, as for any sentence. Nothing is added for no names.
 */
export function addNamed(builder: SummaryBuilder, write: NamedSentence, items: readonly NamedItem[], complete: boolean, lead: readonly (ElementRef | EdgeRef)[] = []): void {
  if (items.length === 0) return;
  const tries = retrySizes(items.length).map((size) => ({ size, text: write(nameList(items.slice(0, size).map((item) => item.title)), size, complete && size === items.length) }));
  const chosen = tries.find((attempt) => builder.fits(attempt.text)) ?? tries[tries.length - 1];
  if (chosen === undefined) return;
  const cites = [...lead, ...items.slice(0, chosen.size).flatMap((item) => (item.ref === undefined ? [] : [item.ref]))];
  if (cites.length > 0) builder.add(chosen.text, cites);
}
