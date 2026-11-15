import { mergeIntoLoaded } from '../api/merge-into-loaded.js';
import type { ClientState } from '../state/client-state.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, edgeKey, elementKey } from '../state/keys.js';
import { drawnKeys } from '../state/loaded-graph.js';
import type { PathElements } from './path-elements.js';

/** What a path asks of the canvas: how many of its entities and relationships are not loaded, and how many of its entities are loaded but hidden by the filters. */
export interface ChosenOutcome {
  readonly missing: number;
  readonly hiddenEntities: number;
}

/** Makes each merge of the session its own, however often the panel was opened and closed. */
let serial = 0;

const keysOf = (elements: PathElements): { readonly nodes: readonly string[]; readonly all: readonly string[] } => {
  const nodes = elements.nodes.map((node) => elementKey(node.ref));
  return { nodes, all: [...nodes, ...elements.edges.map((edge) => edgeKey(edge.ref))] };
};

function show(state: ClientState, elements: PathElements, clearOfX: number): ChosenOutcome {
  const loaded = new Set([...state.loadedGraph().nodes.map((node) => elementKey(node.ref)), ...state.loadedGraph().edges.map((edge) => edgeKey(edge.ref))]);
  const drawn = drawnKeys(state.visibleGraph());
  const { nodes, all } = keysOf(elements);
  const shown = all.filter((key) => drawn.has(key));
  state.presentation.select(shown);
  if (shown.length > 0) state.presentation.fitAround(shown, clearOfX);
  return { missing: all.filter((key) => !loaded.has(key)).length, hiddenEntities: nodes.filter((key) => loaded.has(key) && !drawn.has(key)).length };
}

/**
 * Highlights one path of an answer among what is loaded: its entities and relationships that are drawn are selected and the view is fitted around them, clear of the panel. Nothing is added; the outcome counts
 * what is not loaded. The filters are not changed: an entity that is loaded and hidden by a filter stays hidden and is counted.
 */
export function highlightPath(state: ClientState, elements: PathElements, clearOfX: number): ChosenOutcome {
  return show(state, elements, clearOfX);
}

/** Adds what of a path is not loaded through the merge core (nothing when it is all loaded already), then highlights it. */
export function addPath(state: ClientState, elements: PathElements, context: { readonly sourceId: string; readonly principalId: string; /** The mask of the search the path comes from, which the nodes were read under. */ readonly mask: boolean; readonly clearOfX: number }): ChosenOutcome {
  const current = state.investigation.getState();
  const number = ++serial;
  mergeIntoLoaded(state, {
    sourceId: context.sourceId,
    nodes: elements.nodes,
    edges: elements.edges,
    queryKey: () => ({ sourceId: context.sourceId, principalId: context.principalId, policyVersion: DEFAULT_POLICY_VERSION, filterHash: DEFAULT_FILTER_HASH, params: JSON.stringify(['path', current.id, number]), mask: context.mask }),
  });
  return show(state, elements, context.clearOfX);
}
