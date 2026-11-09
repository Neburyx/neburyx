import { edgeKey, elementKey, isEdgeKey } from '../state/keys.js';
import { drawnKeys, partitionEdges, type LoadedGraph } from '../state/loaded-graph.js';

/**
 * The entity the inspector shows: the one selected key when it is a drawn entity; or, when the one selected element is a drawn relationship that has the entity the inspector was showing (`anchor`) as an end, that entity.
 * None for an empty or larger selection, a relationship of no such entity, or an entity the view does not draw.
 */
export function inspectedKey(selection: ReadonlySet<string>, visible: LoadedGraph, anchor?: string): string | undefined {
  if (selection.size !== 1) return undefined;
  const [key] = selection;
  if (key === undefined) return undefined;
  if (!isEdgeKey(key)) return drawnKeys(visible).has(key) ? key : undefined;
  if (anchor === undefined || !drawnKeys(visible).has(anchor)) return undefined;
  const edge = partitionEdges(visible).drawable.find((candidate) => edgeKey(candidate.ref) === key);
  return edge !== undefined && (elementKey(edge.from) === anchor || elementKey(edge.to) === anchor) ? anchor : undefined;
}
