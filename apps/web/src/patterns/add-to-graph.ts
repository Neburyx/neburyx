import type { TemplateRunOk } from '@neburyx/contracts';
import { outsideFocusNote } from '../canvas/focus-note.js';
import type { ExpandStore } from '../api/expand-store.js';
import { heldKeysOf, mergeIntoLoaded } from '../api/merge-into-loaded.js';
import type { ClientState } from '../state/client-state.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, edgeKey, elementKey } from '../state/keys.js';
import { drawnKeys, outsideFocusKeys } from '../state/loaded-graph.js';

/** What adding a result did, as facts of the client: what is new in the graph and what the graph already held. */
export interface AddedOutcome {
  readonly entities: number;
  readonly relationships: number;
  readonly heldEntities: number;
  readonly heldRelationships: number;
}

export interface AddContext {
  readonly sourceId: string;
  readonly principalId: string;
  /** Where a held entity is kept so that no collapse takes away an entity the person asked for. */
  readonly expansions?: Pick<ExpandStore, 'keep'> | undefined;
}

/** Makes each result key of the session its own, however often the panel was opened and closed. */
let added = 0;

/**
 * Adds a finished result to the loaded graph through the merge core, the way Expand adds what it loaded: the new items are selected where drawn, and when the neighborhood focus is on and some lie outside it a screen reader is told.
 * It makes no read; the result is the page the run returned, so no neighborhood is read in full. Each add has a result key of its own.
 */
export function addResultToGraph(state: ClientState, result: TemplateRunOk, { sourceId, principalId, expansions }: AddContext): AddedOutcome {
  const current = state.investigation.getState();
  const held = heldKeysOf(state);
  const serial = ++added;
  const merged = mergeIntoLoaded(state, {
    sourceId,
    nodes: result.nodes,
    edges: result.edges,
    queryKey: () => ({ sourceId, principalId, policyVersion: DEFAULT_POLICY_VERSION, filterHash: DEFAULT_FILTER_HASH, params: JSON.stringify(['pattern', current.id, result.presetId ?? result.templateId, serial]), mask: state.mask.getState() }),
  });
  for (const node of result.nodes) if (held.nodes.has(elementKey(node.ref))) expansions?.keep(node.ref);
  if (merged.freshNodes.length > 0 || merged.freshEdges.length > 0) {
    const drawn = drawnKeys(state.visibleGraph());
    state.presentation.select([...merged.freshNodes.map((node) => elementKey(node.ref)), ...merged.freshEdges.map((edge) => edgeKey(edge.ref))].filter((key) => drawn.has(key)));
    const { neighborhoodFocus, hidden } = state.presentation.view.getState();
    if (neighborhoodFocus !== undefined) {
      const outside = outsideFocusKeys(state.loadedGraph(), neighborhoodFocus, hidden);
      const note = outsideFocusNote(merged.freshNodes.filter((node) => outside.has(elementKey(node.ref))).length, merged.freshNodes.length);
      if (note !== undefined) state.presentation.announceMove(note);
    }
  }
  return { entities: merged.freshNodes.length, relationships: merged.freshEdges.length, heldEntities: merged.heldNodes, heldRelationships: merged.heldEdges };
}
