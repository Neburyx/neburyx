import { useEffect, useRef } from 'react';
import { useApiClient } from '../api/client-context.js';
import type { ApiFailure } from '../api/client.js';
import { usePrincipalIdWhenProvided } from '../shell/shell-data.js';
import { isSourceChanged } from '../state/investigation-state.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { isAssistantOff } from './failure-kinds.js';
import { rereadThread, takeRead } from './thread-reconcile.js';
import { useAssistantSession } from './assistant-session.js';
import type { StoredThreadState } from './stored-thread-state.js';

/** A refusal that says the investigation is no longer the person's: what the panel shows of it is cleared. */
export const isAccessLost = (failure: ApiFailure): boolean => failure.code === 'NOT_FOUND' || (failure.code === 'ACCESS_DENIED' && !isAssistantOff(failure));

/** The stored turns that are not turns of this session: a turn of this session that the server has already written is in the read too, under the id its request carried. */
export const withoutLiveTurns = <T extends { readonly id: string }>(stored: readonly T[], liveIds: ReadonlySet<string>): T[] => stored.filter((turn) => !liveIds.has(turn.id));

/**
 * Reads the stored thread of the investigation once for the epoch of the panel's session, when the panel is open and the assistant is available, under the session's masking. The answer is kept only if the session has not been cleared since the request began
 * (a change of investigation, principal, masking, source or status clears it). When turns of this session were sent meanwhile, the stored turns that are those turns are left out (matched by the id each request carried, not by a clock or the words), so the earlier conversation shows above them and a turn of this session is never shown twice; a read that was ended by closing the panel is read again when it opens. A lost access clears the
 * panel (its thread, its requests and its history) as it does elsewhere and is not read again; an assistant that the server says is off ends the reading too, and nothing is read while the investigation's source has changed.
 */
export function useStoredThread(available: boolean): StoredThreadState {
  const client = useApiClient();
  const state = useClientState();
  const session = useAssistantSession();
  const { store, stored, open, clear } = session;
  const principalId = usePrincipalIdWhenProvided();
  const held = useStoreSelector(stored, (value) => value);
  const inflight = useRef<AbortController | undefined>(undefined);
  const investigationId = useStoreSelector(state.investigation, (investigation) => investigation.id);
  const sourceChanged = useStoreSelector(state.investigation, (investigation) => isSourceChanged(investigation.record?.sourceState));
  useEffect(() => {
    if (!available || sourceChanged || investigationId === null || principalId === undefined || stored.getState().kind !== 'idle') return;
    const epoch = store.getState().epoch;
    const token = session.invalidated.token;
    const controller = new AbortController();
    inflight.current = controller;
    open.add(controller);
    stored.setState({ kind: 'loading' });
    void client.assistantThread(investigationId, store.getState().mask, controller.signal).then((result) => {
      open.delete(controller);
      if (store.getState().epoch !== epoch) return;
      // a notice of a clearing came while this read was out: it began before it, so it is read again
      if (session.invalidated.token !== token) {
        stored.setState({ kind: 'idle' });
        return;
      }
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
      const taken = takeRead(session, result.value);
      // a read from before a clearing this session has heard of is not shown: the next one is
      if (!taken.show) {
        stored.setState({ kind: 'idle' });
        return;
      }
      const earlier = withoutLiveTurns(taken.thread.turns, new Set(store.getState().turns.flatMap((turn) => turn.turnIds ?? [])));
      stored.setState({ kind: 'ready', thread: { ...taken.thread, turns: earlier } });
    });
  }, [available, clear, client, investigationId, open, principalId, session, sourceChanged, store, stored, held.kind]);
  // closing the panel ends the read it started and no other request of the session
  useEffect(
    () => () => {
      inflight.current?.abort();
    },
    [],
  );
  return held;
}

/** Reads the thread again whenever the window is shown (made visible or focused) with the panel open and the stored thread read once: this is how a window that missed the notice of a clearing learns of it. */
export function useRereadWhenShown(available: boolean): void {
  const client = useApiClient();
  const state = useClientState();
  const session = useAssistantSession();
  const investigationId = useStoreSelector(state.investigation, (investigation) => investigation.id);
  const asked = useStoreSelector(session.refresh, (count) => count);
  const shownThread = useStoreSelector(session.stored, (held) => held.kind);
  useEffect(() => {
    if (!available || investigationId === null || shownThread !== 'ready' || !session.refreshing.pending) return;
    session.refreshing.pending = false;
    void rereadThread(session, (signal) => client.assistantThread(investigationId, session.store.getState().mask, signal));
  }, [asked, available, client, investigationId, session, shownThread]);
  useEffect(() => {
    if (!available || investigationId === null) return;
    const show = (): void => {
      if (document.visibilityState === 'hidden' || session.stored.getState().kind !== 'ready') return;
      void rereadThread(session, (signal) => client.assistantThread(investigationId, session.store.getState().mask, signal));
    };
    document.addEventListener('visibilitychange', show);
    window.addEventListener('focus', show);
    return () => {
      document.removeEventListener('visibilitychange', show);
      window.removeEventListener('focus', show);
    };
  }, [available, client, investigationId, session]);
}
