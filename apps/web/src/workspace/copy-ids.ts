import { edgeKey, elementKey } from '../state/keys.js';
import type { LoadedGraph } from '../state/loaded-graph.js';

export interface CopiedIds {
  /** The stable ID of each selected item whose reference holds one, in selection order. */
  readonly ids: readonly string[];
  /** How many selected items have none: a relationship whose reference is an aggregate or a derived one. */
  readonly withoutId: number;
}

export function idsOfSelection(graph: LoadedGraph, selection: ReadonlySet<string>): CopiedIds {
  const known = new Map<string, string | undefined>();
  for (const node of graph.nodes) known.set(elementKey(node.ref), node.ref.stableId);
  for (const edge of graph.edges) known.set(edgeKey(edge.ref), 'stableId' in edge.ref ? edge.ref.stableId : undefined);
  const ids: string[] = [];
  let withoutId = 0;
  for (const key of selection) {
    if (!known.has(key)) continue;
    const id = known.get(key);
    if (id === undefined) withoutId += 1;
    else ids.push(id);
  }
  return { ids, withoutId };
}
