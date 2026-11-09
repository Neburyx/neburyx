import { isEdgeKey } from '../state/keys.js';
import { drawnKeys, type LoadedGraph } from '../state/loaded-graph.js';

/** The entity the inspector shows: the one selected key when it is a drawn entity; none for an empty or larger selection, a relationship, or an entity the view does not draw. */
export function inspectedKey(selection: ReadonlySet<string>, visible: LoadedGraph): string | undefined {
  if (selection.size !== 1) return undefined;
  const [key] = selection;
  if (key === undefined || isEdgeKey(key)) return undefined;
  return drawnKeys(visible).has(key) ? key : undefined;
}
