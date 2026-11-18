import { useEffect } from 'react';
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
const isAccessLost = (failure: ApiFailure): boolean => failure.code === 'NOT_FOUND' || (failure.code === 'ACCESS_DENIED' && !isAssistantOff(failure));

/**
 * Reads the stored thread of the investigation once for the epoch of the panel's session, when the panel is open and the assistant is available. The answer is kept only if the session has not been cleared since the request began
 * (a change of investigation, principal, masking, source or status clears it) and no live turn has been sent meanwhile, so a late answer never brings rows back and a turn of this session is never shown twice. A lost access clears the
 * panel (its thread, its requests and its history) as it does elsewhere and is not read again; an assistant that the server says is off ends the reading too, and nothing is read while the investigation's source has changed.
 */
export function useStoredThread(available: boolean): StoredThreadState {
  const client = useApiClient();
  const state = useClientState();
  const { store, stored, open, clear } = useAssistantSession();
  const principalId = usePrincipalIdWhenProvided();
  const held = useStoreSelector(stored, (value) => value);
  const investigationId = useStoreSelector(state.investigation, (investigation) => investigation.id);
  const sourceChanged = useStoreSelector(state.investigation, (investigation) => isSourceChanged(investigation.record?.sourceState));
  useEffect(() => {
    if (!available || sourceChanged || investigationId === null || principalId === undefined || stored.getState().kind !== 'idle') return;
    const epoch = store.getState().epoch;
    const controller = new AbortController();
    open.add(controller);
    stored.setState({ kind: 'loading' });
    void client.assistantThread(investigationId, controller.signal).then((result) => {
      open.delete(controller);
      if (controller.signal.aborted || store.getState().epoch !== epoch) return;
      if (!result.ok) {
        if (isAssistantOff(result.failure)) stored.setState({ kind: 'off' });
        else if (isAccessLost(result.failure)) {
          // the thread, the requests that are out and the history all go, and the history is not read again
          clear({ notice: { kind: 'access-lost' } });
          stored.setState({ kind: 'denied' });
        } else stored.setState({ kind: 'failed' });
        return;
      }
      stored.setState(store.getState().turns.length > 0 ? { kind: 'ready', thread: { turns: [], earlierTurns: 0, previousThreadClearedAt: null } } : { kind: 'ready', thread: result.value });
    });
  }, [available, clear, client, investigationId, open, principalId, sourceChanged, store, stored, held.kind]);
  return held;
}
