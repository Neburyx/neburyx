import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { draftSyncOf } from '../draft/draft-sync.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { useClientState } from '../state/context.js';
import { openById } from './open-flow.js';

export type OpenStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly someMissing?: true }
  | { readonly kind: 'not-found'; readonly sourceId?: string }
  | { readonly kind: 'failed'; readonly failure: ApiFailure; readonly sourceId?: string };

/**
 * Opens the investigation of an address into the app-wide client state, as Explore's route does: the one held is shown at once, another is read through the API (so through the gate, with the person's masking switch) and the one on screen stays, identified as its own, until the new one is read. `again` reads it once more after a failure.
 * `heldPath` is where the address goes when the open was given up because another investigation took its place.
 */
export function useOpenInvestigation(client: ApiClient, investigationId: string | undefined, principalId: string | undefined, heldPath: (shownId: string | null) => string = (shownId) => (shownId === null ? '/' : `${EXPLORE_PATH}/${shownId}`)): { readonly status: OpenStatus; readonly again: () => void } {
  const state = useClientState();
  const navigate = useNavigate();
  const sync = draftSyncOf(state, client);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<OpenStatus>(() => (investigationId !== undefined && state.holds(investigationId, state.mask.getState()) ? { kind: 'ready' } : { kind: 'loading' }));
  const loadingNow = useRef(false);
  loadingNow.current = status.kind === 'loading';

  // a change of the masking setting while the investigation is being opened opens it again with the new setting; once it is shown, the setting changes the view where it stands
  useEffect(() => state.mask.subscribe(() => loadingNow.current && setAttempt((count) => count + 1)), [state]);

  // A layout effect, so that a new address never paints the previous investigation before the page has marked it as loading.
  useLayoutEffect(() => {
    if (investigationId === undefined || principalId === undefined) return undefined;
    // another investigation that is held is shown at once, unless the one on screen has changes to write first: the open then settles them
    const mustSettle = state.investigation.getState().id !== investigationId && sync.needsSettle();
    if (!mustSettle && state.resume(investigationId, state.mask.getState()) !== undefined) {
      setStatus({ kind: 'ready' });
      return undefined;
    }
    const controller = new AbortController();
    setStatus({ kind: 'loading' });
    void openById(client, state, investigationId, { principalId, mask: state.mask.getState() }, controller.signal).then((outcome) => {
      if (controller.signal.aborted) return;
      if (outcome.kind === 'held') {
        // the open was given up (another took its place): the address goes back to the investigation that stayed on screen, which is no longer being left
        const shownId = state.investigation.getState().id;
        setStatus({ kind: 'ready' });
        navigate(heldPath(shownId), { replace: true });
        return;
      }
      if (outcome.kind === 'shown') setStatus(outcome.someMissing === true ? { kind: 'ready', someMissing: true } : { kind: 'ready' });
      else {
        const tried = outcome.sourceId === undefined ? {} : { sourceId: outcome.sourceId };
        setStatus(outcome.failure.code === 'NOT_FOUND' ? { kind: 'not-found', ...tried } : { kind: 'failed', failure: outcome.failure, ...tried });
      }
    });
    return () => controller.abort();
  }, [client, state, sync, navigate, investigationId, principalId, attempt]);

  return { status, again: () => setAttempt((count) => count + 1) };
}
