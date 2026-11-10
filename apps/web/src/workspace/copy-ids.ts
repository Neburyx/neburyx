import type { GraphNode, SourceProfile } from '@neburyx/contracts';
import { isUnmappedEdge, isUnmappedNode } from '../draft/unmapped.js';
import { edgeKey, elementKey } from '../state/keys.js';
import type { LoadedGraph } from '../state/loaded-graph.js';

export interface CopiedIds {
  /** The stable ID of each selected item whose reference holds one, in selection order. */
  readonly ids: readonly string[];
  /** How many selected items have none: an aggregate or derived relationship, or an item the mapping no longer covers. */
  readonly withoutId: number;
}

/**
 * What Copy IDs copies for an entity: its stable ID, and for a keyed entity (one whose stable ID is personal data) the value of its stable-ID property when the view is unmasked, and the reference when it is
 * masked, since the value is then masked. The client never reads the text of a reference.
 */
export function copiedIdOf(node: GraphNode, profile: SourceProfile | undefined, mask: boolean): string {
  const type = profile?.entityTypes.find((candidate) => candidate.type === node.ref.entityType);
  if (type?.keyed !== true || mask) return node.ref.stableId;
  const value = node.properties.find((property) => property.key === type.stableIdProperty)?.value;
  if (typeof value === 'string' && value !== '') return value;
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : node.ref.stableId;
}

export function idsOfSelection(graph: LoadedGraph, selection: ReadonlySet<string>, profile?: SourceProfile, mask = false): CopiedIds {
  const known = new Map<string, string | undefined>();
  for (const node of graph.nodes) known.set(elementKey(node.ref), isUnmappedNode(node) ? undefined : copiedIdOf(node, profile, mask));
  for (const edge of graph.edges) known.set(edgeKey(edge.ref), 'stableId' in edge.ref && !isUnmappedEdge(edge) ? edge.ref.stableId : undefined);
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
