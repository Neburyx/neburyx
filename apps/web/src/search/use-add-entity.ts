import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphNode } from '@neburyx/contracts';
import type { ApiClient, ApiFailure, ApiResult } from '../api/client.js';
import { UNEXPECTED } from '../api/use-request.js';
import type { ExpandStore } from '../api/expand-store.js';
import { useExpandStoreWhenProvided } from '../workspace/expand-context.js';
import { leaveFocus } from '../canvas/focus-commands.js';
import type { ClientState } from '../state/client-state.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, elementKey, type QueryKey } from '../state/keys.js';

export interface AddEntity {
  readonly add: (node: GraphNode) => void;
  readonly loading: ReadonlySet<string>;
  readonly failures: ReadonlyMap<string, ApiFailure>;
  readonly added: string | undefined;
}

function addedKey(investigationId: string | null, sourceId: string, principalId: string, node: GraphNode, mask: boolean): QueryKey {
  return { sourceId, principalId, policyVersion: DEFAULT_POLICY_VERSION, filterHash: DEFAULT_FILTER_HASH, params: JSON.stringify(['added', investigationId, node.ref.entityType, node.ref.stableId]), mask };
}

/** Puts a loaded entity beside the entities the investigation holds now, which is not the state at the press: an answer that arrives after another entity was added keeps that one too. */
function place(state: ClientState, sourceId: string, principalId: string, mask: boolean, node: GraphNode, expansions: ExpandStore | undefined): void {
  const current = state.investigation.getState();
  if (current.sourceId !== sourceId) return;
  if (current.nodeRefs.some((ref) => elementKey(ref) === elementKey(node.ref))) {
    // an expansion put the entity on the canvas while the answer was on its way: the person asked for it, so no collapse takes it away
    expansions?.keep(node.ref);
    return;
  }
  const key = addedKey(current.id, sourceId, principalId, node, mask);
  state.putResult(key, { sourceId, nodes: [node], edges: [] });
  state.setLoaded([...current.resultKeys, key], [...current.nodeRefs, node.ref], [...current.edgeRefs]);
  // An entity added while focus is on is joined to none, so it would be loaded and not drawn: focus ends first.
  if (state.presentation.view.getState().neighborhoodFocus !== undefined) leaveFocus(state);
}

/** Work started here is aborted when the component using it goes away; its parent keys it by the context, so an answer that arrives after a change adds nothing. */
export function useAddEntity(client: ApiClient, state: ClientState, sourceId: string, principalId: string | undefined, mask: boolean): AddEntity {
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, ApiFailure>>(new Map());
  const [added, setAdded] = useState<string | undefined>(undefined);
  const running = useRef(new Map<string, AbortController>());
  const expansions = useExpandStoreWhenProvided();

  useEffect(() => {
    const controllers = running.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    };
  }, []);

  const add = useCallback(
    (node: GraphNode): void => {
      const key = elementKey(node.ref);
      if (principalId === undefined || running.current.has(key) || state.investigation.getState().nodeRefs.some((ref) => elementKey(ref) === key)) return;
      const controller = new AbortController();
      running.current.set(key, controller);
      setLoading((previous) => new Set(previous).add(key));
      setFailures((previous) => {
        if (!previous.has(key)) return previous;
        const next = new Map(previous);
        next.delete(key);
        return next;
      });
      const load = async (): Promise<ApiResult<GraphNode>> => {
        try {
          return await client.getEntity(node.ref, { mask }, controller.signal);
        } catch {
          return UNEXPECTED;
        }
      };
      void load().then((result) => {
        if (controller.signal.aborted) return;
        running.current.delete(key);
        setLoading((previous) => {
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
        if (!result.ok) return void setFailures((previous) => new Map(previous).set(key, result.failure));
        if (result.value.ref.sourceId !== sourceId || elementKey(result.value.ref) !== key) return void setFailures((previous) => new Map(previous).set(key, { code: 'SCHEMA_MISMATCH' }));
        place(state, sourceId, principalId, mask, result.value, expansions);
        setAdded(result.value.display.title);
      });
    },
    [client, state, sourceId, principalId, mask, expansions],
  );

  return { add, loading, failures, added };
}
