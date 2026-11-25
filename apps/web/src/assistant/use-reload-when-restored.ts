import { useCallback, useEffect, useRef } from 'react';
import { useApiClient } from '../api/client-context.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useAssistantSession } from './assistant-session.js';
import { reloadThread } from './thread-reconcile.js';

/** When the panel comes back after being collapsed, reads the stored thread once and shows what the server holds, so that the turns made in the other window are in it. A read that fails is tried again each time the window is shown until one is answered. */
export function useReloadWhenRestored(collapsed: boolean): void {
  const client = useApiClient();
  const state = useClientState();
  const session = useAssistantSession();
  const investigationId = useStoreSelector(state.investigation, (investigation) => investigation.id);
  const wasCollapsed = useRef(false);
  const failed = useRef(false);
  const reload = useCallback(async (): Promise<void> => {
    if (investigationId === null || session.stored.getState().kind !== 'ready') return;
    failed.current = !(await reloadThread(session, (signal) => client.assistantThread(investigationId, session.store.getState().mask, signal)));
  }, [client, investigationId, session]);
  useEffect(() => {
    if (collapsed) {
      wasCollapsed.current = true;
      return;
    }
    if (!wasCollapsed.current) return;
    wasCollapsed.current = false;
    void reload();
  }, [collapsed, reload]);
  useEffect(() => {
    if (collapsed) return undefined;
    const shown = (): void => {
      if (failed.current && document.visibilityState !== 'hidden') void reload();
    };
    document.addEventListener('visibilitychange', shown);
    window.addEventListener('focus', shown);
    return () => {
      document.removeEventListener('visibilitychange', shown);
      window.removeEventListener('focus', shown);
    };
  }, [collapsed, reload]);
}
