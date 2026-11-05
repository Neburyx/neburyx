import type { SourceProfile } from '@neburyx/contracts';
import { edgeKey, elementKey } from '../state/keys.js';
import { partitionEdges, type LoadedGraph } from '../state/loaded-graph.js';
import { relationshipParts } from './relationship-look.js';

/** The elements the walk visits: the drawn entities in their loaded order, then the drawn relationships in theirs. */
export function walkOrder(graph: LoadedGraph): readonly string[] {
  return [...graph.nodes.map((node) => elementKey(node.ref)), ...partitionEdges(graph).drawable.map((edge) => edgeKey(edge.ref))];
}

/** The element a step from `at` lands on, wrapping at the ends; from no element (or one that is not in the order) a step forward lands on the first and a step back on the last. */
export function stepWalk(order: readonly string[], at: string | undefined, direction: 1 | -1): string | undefined {
  if (order.length === 0) return undefined;
  const index = at === undefined ? -1 : order.indexOf(at);
  if (index === -1) return direction === 1 ? order[0] : order[order.length - 1];
  return order[(index + direction + order.length) % order.length];
}

/** What a screen reader is told when the walk reaches an element: an entity by its title and its type's display name, and "pinned" when it is; a relationship by its label as the canvas reads it and its two ends. */
export function describeWalked(graph: LoadedGraph, profile: SourceProfile | undefined, pins: ReadonlySet<string>, key: string): string | undefined {
  const titles = new Map(graph.nodes.map((node) => [elementKey(node.ref), node.display.title]));
  const node = graph.nodes.find((candidate) => elementKey(candidate.ref) === key);
  if (node !== undefined) {
    const typeName = profile?.entityTypes.find((entry) => entry.type === node.ref.entityType)?.displayName ?? node.ref.entityType;
    return [node.display.title, typeName, ...(pins.has(key) ? ['pinned'] : [])].join(', ');
  }
  const edge = graph.edges.find((candidate) => edgeKey(candidate.ref) === key);
  if (edge === undefined) return undefined;
  const { type, count, origin } = relationshipParts(edge);
  const label = [type, count, origin].filter((part) => part !== undefined).join(' · ');
  return `${label}, from ${titles.get(elementKey(edge.from)) ?? ''} to ${titles.get(elementKey(edge.to)) ?? ''}`;
}
