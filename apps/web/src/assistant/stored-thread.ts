import { useEffect, useRef } from 'react';
import { useApiClient } from '../api/client-context.js';
import type { ApiFailure } from '../api/client.js';
import { usePrincipalIdWhenProvided } from '../shell/shell-data.js';
import { isSourceChanged } from '../state/investigation-state.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { isAssistantOff } from './failure-kinds.js';
import { useAssistantSession } from './assistant-session.js';
import type { StoredThreadState } from './stored-thread-state.js';

/** A refusal that says the investigation is no longer the person's: what the panel shows of it is cleared. */
export const isAccessLost = (failure: ApiFailure): boolean => failure.code === 'NOT_FOUND' || (failure.code === 'ACCESS_DENIED' && !isAssistantOff(failure));

/**
 * The stored turns that are not turns of this session. A turn of this session that the server has already written is in the read too, as the newest of its turns: each live message, from the newest, takes the newest stored turn with that question within the
 * last few stored turns, so that a turn the server did not write (it failed) takes none, and an earlier turn with the same words is not taken.
 */
export function withoutLiveTurns<T extends { readonly question?: string | undefined }>(stored: readonly T[], messages: readonly string[]): T[] {
  const taken = new Set<number>();
  let from = stored.length - 1;
  for (const message of [...messages].reverse()) {
    for (let index = from; index >= 0 && from - index <= messages.length; index -= 1) {
      if (taken.has(index) || stored[index]?.question !== message) continue;
      taken.add(index);
      from = index - 1;
      break;
    }
  }
  return stored.filter((_, index) => !taken.has(index));
}

/**
 * Reads the stored thread of the investigation once for the epoch of the panel's session, when the panel is open and the assistant is available, under the session's masking. The answer is kept only if the session has not been cleared since the request began
 * (a change of investigation, principal, masking, source or status clears it). When turns of this session were sent meanwhile, the stored turns that are those turns are left out (matched by their question, not by a clock), so the earlier conversation shows above them and a turn of this session is never shown twice; a read that was ended by closing the panel is read again when it opens. A lost access clears the
 * panel (its thread, its requests and its history) as it does elsewhere and is not read again; an assistant that the server says is off ends the reading too, and nothing is read while the investigation's source has changed.
 */
export function useStoredThread(available: boolean): StoredThreadState {
  const client = useApiClient();
  const state = useClientState();
  const { store, stored, open, clear } = useAssistantSession();
  const principalId = usePrincipalIdWhenProvided();
  const held = useStoreSelector(stored, (value) => value);
  const inflight = useRef<AbortController | undefined>(undefined);
  const investigationId = useStoreSelector(state.investigation, (investigation) => investigation.id);
  const sourceChanged = useStoreSelector(state.investigation, (investigation) => isSourceChanged(investigation.record?.sourceState));
  useEffect(() => {
    if (!available || sourceChanged || investigationId === null || principalId === undefined || stored.getState().kind !== 'idle') return;
    const epoch = store.getState().epoch;
    const controller = new AbortController();
    inflight.current = controller;
    open.add(controller);
    stored.setState({ kind: 'loading' });
    void client.assistantThread(investigationId, store.getState().mask, controller.signal).then((result) => {
      open.delete(controller);
      if (store.getState().epoch !== epoch) return;
      if (controller.signal.aborted) {
        if (stored.getState().kind === 'loading') stored.setState({ kind: 'idle' });
        return;
      }
      if (!result.ok) {
        if (isAssistantOff(result.failure)) stored.setState({ kind: 'off' });
        else if (isAccessLost(result.failure)) {
          // the thread, the requests that are out and the history all go, and the history is not read again
          clear({ notice: { kind: 'access-lost' } });
          stored.setState({ kind: 'denied' });
        } else stored.setState({ kind: 'failed' });
        return;
      }
      const earlier = withoutLiveTurns(result.value.turns, store.getState().turns.map((turn) => turn.message));
      stored.setState({ kind: 'ready', thread: { ...result.value, turns: earlier } });
    });
  }, [available, clear, client, investigationId, open, principalId, sourceChanged, store, stored, held.kind]);
  // closing the panel ends the read it started and no other request of the session
  useEffect(
    () => () => {
      inflight.current?.abort();
    },
    [],
  );
  return held;
}
