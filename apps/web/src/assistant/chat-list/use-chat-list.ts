import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantThreadListResponse } from '@neburyx/contracts';
import type { ApiFailure } from '../../api/client.js';
import { useApiClient } from '../../api/client-context.js';
import { READ_WAIT_MS } from '../read-wait.js';
import { SETTLE_RETRY_MS } from '../settle-retry.js';

export type ChatRow = AssistantThreadListResponse['items'][number];

/** What the list of chats holds: the rows of the pages read so far, the cursor of the next page, and how the read of the first page and the read of more are going. A failure keeps the rows that were shown. */
export interface ChatListState {
  readonly rows: readonly ChatRow[];
  readonly nextCursor: string | null;
  readonly first: 'loading' | 'ready' | 'failed';
  readonly firstFailure: ApiFailure | undefined;
  readonly more: 'idle' | 'loading' | 'failed';
  readonly moreFailure: ApiFailure | undefined;
}

/** The most pages a reread reads to give back the chats that were shown: each page is bounded by the server, so the reread is too. */
const MAX_REREAD_PAGES = 10;

/** A list read longer ago than this is read again when the person points at it or moves into it: a tab switch or a click in a window that was already focused sends no event of its own. */
const STALE_AFTER_MS = 3000;

const START: ChatListState = { rows: [], nextCursor: null, first: 'loading', firstFailure: undefined, more: 'idle', moreFailure: undefined };

/**
 * The caller's chats for a search text (none for no search), read again whenever `trigger` changes or `reload` is called. Only the answer of the newest read is applied: a stale one is dropped. A cursor the server no longer accepts
 * (`CURSOR_INVALIDATED`) starts again from the first page, keeping the rows on screen until it answers.
 */
export function useChatList(query: string | undefined, trigger: unknown): { readonly state: ChatListState; readonly reload: () => void; readonly turnAnswered: (investigationId: string | null) => void; readonly refreshIfOld: () => void; readonly loadMore: () => void } {
  const client = useApiClient();
  const [state, setState] = useState<ChatListState>(START);
  const [reloads, setReloads] = useState(0);
  const generation = useRef(0);
  const held = useRef(state);
  held.current = state;

  const lastQuery = useRef(query);
  /** A turn was answered in this chat: read until its row shows one more turn than before (or a few tries have passed). */
  const waiting = useRef<{ readonly investigationId: string; readonly turns: number; attempt: number } | undefined>(undefined);
  const retry = useRef<number | undefined>(undefined);
  const lastRead = useRef(Date.now());
  /** How many chats of the list with no search were read: the list that comes back when a search is cleared keeps that many. */
  const plainCount = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    const controller = new AbortController();
    // a reread for the same search keeps as many pages as were shown; a new search starts from its first page
    const keep = query === undefined ? plainCount.current : lastQuery.current === query ? held.current.rows.length : 0;
    lastQuery.current = query;
    setState((current) => ({ ...current, first: 'loading', firstFailure: undefined, more: 'idle', moreFailure: undefined }));
    const search = query === undefined ? {} : { q: query };
    // a read that gets no answer in time is given up: its late answer is dropped, and the person sees the failure with Try again
    const giveUp = window.setTimeout(() => {
      if (mine !== generation.current) return;
      generation.current += 1;
      controller.abort();
      lastRead.current = Date.now();
      setState((current) => ({ ...current, first: 'failed', firstFailure: { code: 'NETWORK_UNAVAILABLE' } }));
    }, READ_WAIT_MS);
    void (async () => {
      let result = await client.listAssistantThreads(search, controller.signal);
      let pages = 1;
      let rows: readonly ChatRow[] = result.ok ? result.value.items : [];
      while (result.ok && result.value.nextCursor !== null && rows.length < keep && pages < MAX_REREAD_PAGES) {
        const next = await client.listAssistantThreads({ cursor: result.value.nextCursor, ...search }, controller.signal);
        pages += 1;
        if (!next.ok) {
          // the first page was read: what could not be read again is left to Show more
          result = { ok: true, value: { items: [...rows], nextCursor: result.value.nextCursor } };
          break;
        }
        const seen = new Set(rows.map((row) => row.investigationId));
        rows = [...rows, ...next.value.items.filter((row) => !seen.has(row.investigationId))];
        result = { ok: true, value: { items: [...rows], nextCursor: next.value.nextCursor } };
      }
      window.clearTimeout(giveUp);
      if (mine !== generation.current) return;
      lastRead.current = Date.now();
      if (query === undefined && result.ok) plainCount.current = result.value.items.length;
      const wait = waiting.current;
      if (wait !== undefined && !result.ok) waiting.current = undefined;
      if (wait !== undefined && result.ok) {
        const row = result.value.items.find((item) => item.investigationId === wait.investigationId);
        if (query !== undefined || (row !== undefined && row.turns > wait.turns) || wait.attempt >= SETTLE_RETRY_MS.length) waiting.current = undefined;
        else {
          const delay = SETTLE_RETRY_MS[wait.attempt] ?? 0;
          wait.attempt += 1;
          retry.current = window.setTimeout(() => setReloads((count) => count + 1), delay);
        }
      }
      setState((current) => (result.ok ? { rows: result.value.items, nextCursor: result.value.nextCursor, first: 'ready', firstFailure: undefined, more: 'idle', moreFailure: undefined } : { ...current, first: 'failed', firstFailure: result.failure }));
    })();
    return () => {
      generation.current += 1;
      controller.abort();
      window.clearTimeout(giveUp);
      window.clearTimeout(retry.current);
    };
  }, [client, query, trigger, reloads]);

  const reload = useCallback(() => setReloads((count) => count + 1), []);

  const refreshIfOld = useCallback(() => {
    if (held.current.first !== 'ready' || Date.now() - lastRead.current < STALE_AFTER_MS) return;
    setReloads((count) => count + 1);
  }, []);

  const turnAnswered = useCallback((investigationId: string | null) => {
    const before = investigationId === null ? undefined : held.current.rows.find((row) => row.investigationId === investigationId);
    waiting.current = investigationId === null ? undefined : { investigationId, turns: before?.turns ?? 0, attempt: 0 };
    setReloads((count) => count + 1);
  }, []);

  const loadMore = useCallback(() => {
    const current = held.current;
    if (current.nextCursor === null || current.more === 'loading') return;
    const cursor = current.nextCursor;
    const mine = generation.current;
    setState((now) => ({ ...now, more: 'loading', moreFailure: undefined }));
    void client.listAssistantThreads({ cursor, ...(query === undefined ? {} : { q: query }) }).then((result) => {
      if (mine !== generation.current) return;
      if (result.ok) {
        setState((now) => {
          const seen = new Set(now.rows.map((row) => row.investigationId));
          if (query === undefined) plainCount.current = now.rows.length + result.value.items.filter((row) => !seen.has(row.investigationId)).length;
          return { ...now, rows: [...now.rows, ...result.value.items.filter((row) => !seen.has(row.investigationId))], nextCursor: result.value.nextCursor, more: 'idle', moreFailure: undefined };
        });
      } else if ('code' in result.failure && result.failure.code === 'CURSOR_INVALIDATED') {
        setState((now) => ({ ...now, more: 'idle', moreFailure: undefined }));
        setReloads((count) => count + 1);
      } else {
        setState((now) => ({ ...now, more: 'failed', moreFailure: result.failure }));
      }
    });
  }, [client, query]);

  return { state, reload, turnAnswered, refreshIfOld, loadMore };
}
