import { mergeIntoLoaded } from '../api/merge-into-loaded.js';
import type { ClientState } from '../state/client-state.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, edgeKey, elementKey } from '../state/keys.js';
import { drawnKeys } from '../state/loaded-graph.js';
import type { PathElements } from './path-elements.js';

/** What choosing a path did: how many of its entities and relationships were not loaded before, and how many of its entities stay hidden by the filters. */
export interface ChosenOutcome {
  readonly added: number;
  readonly hiddenEntities: number;
}

/** Makes each merge of the session its own, however often the panel was opened and closed. */
let serial = 0;

/**
 * Shows one path of an answer on the canvas: what of it is not loaded is added through the merge core (nothing when it is all loaded already), and its entities and relationships that are drawn are
 * selected, with the view fitted to what is drawn. The filters are not changed: an entity that is loaded and hidden by a filter stays hidden and is counted.
 */
export function choosePath(state: ClientState, elements: PathElements, context: { readonly sourceId: string; readonly principalId: string; /** The mask of the search the path comes from, which the nodes were read under. */ readonly mask: boolean }): ChosenOutcome {
  const current = state.investigation.getState();
  const number = ++serial;
  const merged = mergeIntoLoaded(state, {
    sourceId: context.sourceId,
    nodes: elements.nodes,
    edges: elements.edges,
    queryKey: () => ({ sourceId: context.sourceId, principalId: context.principalId, policyVersion: DEFAULT_POLICY_VERSION, filterHash: DEFAULT_FILTER_HASH, params: JSON.stringify(['path', current.id, number]), mask: context.mask }),
  });
  const drawn = drawnKeys(state.visibleGraph());
  const nodeKeys = elements.nodes.map((node) => elementKey(node.ref));
  state.presentation.select([...nodeKeys, ...elements.edges.map((edge) => edgeKey(edge.ref))].filter((key) => drawn.has(key)));
  state.presentation.applyLayout(new Map());
  return { added: merged.freshNodes.length + merged.freshEdges.length, hiddenEntities: nodeKeys.filter((key) => !drawn.has(key)).length };
}
