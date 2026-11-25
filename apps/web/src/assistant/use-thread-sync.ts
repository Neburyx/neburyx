import { useCallback, useEffect, useRef } from 'react';
import { useApiClient } from '../api/client-context.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useWindowChannel, useWindowScope } from '../windows/use-window-channel.js';
import { useAssistantSession, type Turn } from './assistant-session.js';
import { reloadThread } from './thread-reconcile.js';

/**
 * Keeps the stored thread of this window as the server holds it while the chat shows in more than one window. It reads the thread once when the panel comes back after being collapsed, and each time another window says the thread changed; a read that fails is tried again each time this window is shown, until one is answered. It tells the other windows when a turn of this window settles. The notice holds no text: every window reads the thread through its own read, with its own masking, and a turn that is pending here or a draft is not touched.
 */
export function useThreadSync(collapsed: boolean, turns: readonly Turn[]): { readonly announceChanged: () => void } {
  const client = useApiClient();
  const state = useClientState();
  const session = useAssistantSession();
  const channel = useWindowChannel(useWindowScope());
  const investigationId = useStoreSelector(state.investigation, (investigation) => investigation.id);
  const wasCollapsed = useRef(false);
  const failed = useRef(false);
  const running = useRef(false);
  const again = useRef(false);
  const reload = useCallback(async (): Promise<void> => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        again.current = false;
        if (investigationId === null || session.stored.getState().kind !== 'ready') break;
        failed.current = !(await reloadThread(session, (signal) => client.assistantThread(investigationId, session.store.getState().mask, signal)));
      } while (again.current);
    } finally {
      running.current = false;
    }
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
    const shown = (): void => {
      if (failed.current && !collapsed && document.visibilityState !== 'hidden') void reload();
    };
    document.addEventListener('visibilitychange', shown);
    window.addEventListener('focus', shown);
    return () => {
      document.removeEventListener('visibilitychange', shown);
      window.removeEventListener('focus', shown);
    };
  }, [collapsed, reload]);
  useEffect(() => (channel === undefined ? undefined : channel.onThreadChanged(() => void reload())), [channel, reload]);
  const pending = useRef<ReadonlySet<number>>(new Set());
  useEffect(() => {
    const now = new Set(turns.filter((turn) => turn.outcome.kind === 'pending').map((turn) => turn.id));
    const settled = [...pending.current].some((id) => !now.has(id));
    pending.current = now;
    if (settled) channel?.announceThreadChanged();
  }, [turns, channel]);
  const announceChanged = useCallback(() => channel?.announceThreadChanged(), [channel]);
  return { announceChanged };
}
