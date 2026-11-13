import type { DerivedNeighborsResponse, ElementRef } from '@neburyx/contracts';
import { outsideFocusNote } from '../canvas/focus-note.js';
import type { ClientState } from '../state/client-state.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, elementKey } from '../state/keys.js';
import { outsideFocusKeys } from '../state/loaded-graph.js';
import type { ApiClient } from './client.js';
import { mergeIntoLoaded } from './merge-into-loaded.js';
import { createRequestStore, type RequestStore } from './request-store.js';

export interface ShownOutcome {
  /** The nodes and the edges that the view did not hold and now does. */
  readonly nodes: number;
  readonly edges: number;
  /** What a screen reader is told when some of what was loaded is outside the neighborhood focus; absent when focus is off or nothing is outside it. */
  readonly focusNote?: string;
}

export interface DerivedStore {
  /** The request for the rule-derived neighbors of a node: made once, when the inspector first shows the node, and kept for the session; ask again with its `reload`. */
  forNode(ref: ElementRef, mask: boolean): RequestStore<DerivedNeighborsResponse>;
  /** The answered result of one rule for a node under the session's masking setting; it never asks. */
  held(ref: ElementRef, ruleId: string): DerivedNeighborsResponse['results'][number] | undefined;
  /** Puts what a rule's answer holds, and that the view does not, into the view as one loaded result, with no read of its own and without changing the selection, so that the inspector and the focus stay; undefined when there is no answer to show. */
  show(ref: ElementRef, ruleId: string): ShownOutcome | undefined;
}

const keyOf = (person: string, investigation: string, ref: ElementRef, mask: boolean): string => JSON.stringify([person, investigation, ref.sourceId, ref.entityType, ref.stableId, mask]);

/**
 * The rule-derived neighbors a person's session has asked for, each a request store of its own under the person, investigation, source, node and masking setting that asked, so an answer for one node is never shown for another.
 * Showing an answer adds its nodes and edges to the loaded graph the way an expansion's answer is added, but makes no read: what is drawn is what was counted.
 */
export function createDerivedStore(client: ApiClient, state: ClientState, person: () => string, investigation: () => string): DerivedStore {
  const requests = new Map<string, RequestStore<DerivedNeighborsResponse>>();
  let counter = 0;
  const answerOf = (ref: ElementRef): DerivedNeighborsResponse | undefined => {
    const held = requests.get(keyOf(person(), investigation(), ref, state.mask.getState()))?.getState();
    return held?.phase === 'ready' ? held.data : undefined;
  };
  return {
    forNode(ref, mask) {
      const key = keyOf(person(), investigation(), ref, mask);
      const held = requests.get(key);
      if (held !== undefined) return held;
      const request = createRequestStore((signal) => client.derivedNeighbors({ sourceId: ref.sourceId, ref: { entityType: ref.entityType, stableId: ref.stableId }, ...(mask ? { mask } : {}) }, signal));
      requests.set(key, request);
      return request;
    },
    held: (ref, ruleId) => answerOf(ref)?.results.find((entry) => entry.ruleId === ruleId),
    show(ref, ruleId) {
      const result = answerOf(ref)?.results.find((entry) => entry.ruleId === ruleId);
      if (result === undefined) return undefined;
      const current = state.investigation.getState();
      const { freshNodes: nodes, freshEdges: edges } = mergeIntoLoaded(state, {
        sourceId: ref.sourceId,
        nodes: result.nodes,
        edges: result.edges,
        queryKey: () => ({ sourceId: ref.sourceId, principalId: person(), policyVersion: DEFAULT_POLICY_VERSION, filterHash: DEFAULT_FILTER_HASH, params: JSON.stringify(['derived', current.id, elementKey(ref), ruleId, ++counter]), mask: state.mask.getState() }),
      });
      if (nodes.length === 0 && edges.length === 0) return { nodes: 0, edges: 0 };
      const { neighborhoodFocus, hidden } = state.presentation.view.getState();
      const outside = outsideFocusKeys(state.loadedGraph(), neighborhoodFocus, hidden);
      const focusNote = outsideFocusNote(nodes.filter((node) => outside.has(elementKey(node.ref))).length, nodes.length);
      return { nodes: nodes.length, edges: edges.length, ...(focusNote === undefined ? {} : { focusNote }) };
    },
  };
}
