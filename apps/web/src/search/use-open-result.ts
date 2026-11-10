import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { GraphNode } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { openEntity } from '../investigations/open-flow.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { useClientState, useSessionMask } from '../state/context.js';

export type OpenRefusal = { readonly kind: 'failure'; readonly failure: ApiFailure } | { readonly kind: 'source-unavailable' };

export interface OpenResult {
  readonly open: (node: GraphNode) => void;
  /** True while an open is in progress: a press then does nothing. */
  readonly busy: boolean;
  readonly refusal: OpenRefusal | undefined;
}

/**
 * Opens a hit as an investigation of the source it names and shows it in Explore. One open at a time: a second press makes no second call. An open that completes after
 * the person left the page, or after the mask changed, shows and navigates nowhere.
 */
export function useOpenResult(client: ApiClient, principalId: string): OpenResult {
  const state = useClientState();
  const mask = useSessionMask();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<OpenRefusal | undefined>(undefined);
  const attempt = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => attempt.current?.abort(), [mask]);

  const open = useCallback(
    (node: GraphNode): void => {
      if (attempt.current !== undefined && !attempt.current.signal.aborted) return;
      const controller = new AbortController();
      attempt.current = controller;
      setBusy(true);
      setRefusal(undefined);
      const request = { sourceId: node.ref.sourceId, entity: node.ref };
      void openEntity(client, state, request, { principalId, mask }, controller.signal)
        .then((outcome) => {
          if (controller.signal.aborted) return;
          if (outcome.kind === 'held') return;
          if (outcome.kind === 'shown') navigate(`${EXPLORE_PATH}/${outcome.id}`, { state: { resumed: outcome.created === false } });
          else setRefusal(outcome.kind === 'failed' ? { kind: 'failure', failure: outcome.failure } : { kind: 'source-unavailable' });
        })
        .finally(() => {
          if (attempt.current !== controller) return;
          attempt.current = undefined;
          setBusy(false);
        });
    },
    [client, state, principalId, mask, navigate],
  );

  return { open, busy, refusal };
}
