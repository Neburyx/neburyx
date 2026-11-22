import type { GraphEdge, GraphNode, SourceProfile } from '@neburyx/contracts';
import { testProfile } from '../dev/test-profile.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { edge, key, node, ref } from '../state/test-data.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { elementKey } from '../state/keys.js';

const count = { value: 0, quality: 'exact' as const, scope: 'loaded in this view' };

export const graphOf = (nodes: readonly GraphNode[], edges: readonly GraphEdge[] = []): LoadedGraph => ({ nodes, edges, entities: count, relationships: count });

/** An entity of a type with the given properties. */
export function entityOf(type: string, id: string, properties: Readonly<Record<string, unknown>> = {}): GraphNode {
  const base = node('a', id);
  return { ...base, ref: ref('a', type, id), display: { title: id, type }, properties: Object.entries(properties).map(([key, value]) => ({ key, value, dataClass: 'text' as const, masked: false })) };
}

/** A stored relationship between two entities of the kinds named. */
export function linkOf(id: string, from: GraphNode, to: GraphNode, extra: Partial<GraphEdge> = {}): GraphEdge {
  const base = edge('a', id, from.ref.stableId, to.ref.stableId);
  return { ...base, from: from.ref, to: to.ref, ref: { sourceId: 'a', type: 'rel-a', from: from.ref.entityType, to: to.ref.entityType, stableId: id }, ...extra };
}

export const keyOf = (entity: GraphNode): string => elementKey(entity.ref);

/** A profile that lists the types with the names shown and the pii and mapped properties given. */
export function profileWith(types: Readonly<Record<string, { readonly name?: string; readonly pii?: readonly string[]; readonly properties?: readonly string[] }>>): SourceProfile {
  const base = testProfile('a', Object.keys(types));
  return { ...base, entityTypes: base.entityTypes.map((entry) => ({ ...entry, displayName: types[entry.type]?.name ?? entry.displayName, pii: [...(types[entry.type]?.pii ?? [])], properties: [...(types[entry.type]?.properties ?? [])] })) };
}

/** A client state that holds these entities and relationships as the loaded view of source `a`. */
export function loadedState(nodes: readonly GraphNode[], edges: readonly GraphEdge[] = []): ClientState {
  const state = createClientState();
  state.bindSource('a');
  const queryKey = key('a', 'group-kit');
  state.putResult(queryKey, { sourceId: 'a', nodes: [...nodes], edges: [...edges] });
  state.setLoaded([queryKey], nodes.map((entry) => entry.ref), edges.map((entry) => entry.ref));
  return state;
}

/** The item at an index, which a test knows is there. */
export function at<T>(list: readonly T[], index: number): T {
  const found = list[index];
  if (found === undefined) throw new Error(`no item at ${index}`);
  return found;
}
