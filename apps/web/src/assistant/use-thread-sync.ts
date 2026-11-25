import { useCallback, useEffect, useRef } from 'react';
import { useApiClient } from '../api/client-context.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useWindowChannel, useWindowScope } from '../windows/use-window-channel.js';
import { useAssistantSession, type Turn } from './assistant-session.js';
import { SETTLE_RETRY_MS } from './settle-retry.js';
import { reloadThread } from './thread-reconcile.js';

/**
 * Keeps the stored thread of this window as the server holds it while the chat shows in more than one window. It reads the thread once when the panel comes back after being collapsed. When another window says the thread changed it reads it, and again after each wait of `SETTLE_RETRY_MS` until what the server holds differs from what this window held (the server stores a turn a moment after it has answered it); a read that fails is tried again each time this window is shown, until one is answered. It tells the other windows when a turn of this window settles. The notice holds no text: every window reads the thread through its own read, with its own masking, and a turn that is pending here or a draft is not touched.
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
  const reload = useCallback(async (): Promise<number | undefined> => {
    if (running.current) {
      again.current = true;
      return undefined;
    }
    running.current = true;
    let held: number | undefined;
    try {
      do {
        again.current = false;
        if (investigationId === null || session.stored.getState().kind !== 'ready') break;
        const done = await reloadThread(session, (signal) => client.assistantThread(investigationId, session.store.getState().mask, signal));
        failed.current = done.failed;
        held = done.held;
      } while (again.current);
    } finally {
      running.current = false;
    }
    return held;
  }, [client, investigationId, session]);
  const waiting = useRef<number | undefined>(undefined);
  const heldTurns = useCallback((): number => {
    const stored = session.stored.getState();
    const listed = stored.kind === 'ready' ? stored.thread.turns.length + stored.thread.earlierTurns : 0;
    return listed + session.store.getState().turns.reduce((sum, turn) => sum + (turn.outcome.kind === 'pending' ? 0 : (turn.turnIds ?? []).length), 0);
  }, [session]);
  const changed = useCallback((): void => {
    window.clearTimeout(waiting.current);
    const before = heldTurns();
    const attempt = (index: number): void => {
      void reload().then((held) => {
        if (held !== undefined && held !== before) return;
        const wait = SETTLE_RETRY_MS[index];
        if (wait !== undefined) waiting.current = window.setTimeout(() => attempt(index + 1), wait);
      });
    };
    attempt(0);
  }, [heldTurns, reload]);
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
  useEffect(() => (channel === undefined ? undefined : channel.onThreadChanged(changed)), [channel, changed]);
  useEffect(() => () => window.clearTimeout(waiting.current), []);
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
