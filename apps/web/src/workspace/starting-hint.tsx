import { useLoadedGraph } from '../state/context.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { STARTING_ENTITY_HINT } from './expand-copy.js';

export const isOnlyStartingEntity = (graph: LoadedGraph): boolean => graph.nodes.length === 1 && graph.edges.length === 0;

/** Tells a person who sees one entity how to load its neighbors; it is gone as soon as the loaded graph holds anything more. */
export function StartingEntityHint() {
  const graph = useLoadedGraph();
  if (!isOnlyStartingEntity(graph)) return null;
  return (
    <p role="status" className="starting-hint">
      {STARTING_ENTITY_HINT}
    </p>
  );
}
