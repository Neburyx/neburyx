import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantThreadListResponse } from '@neburyx/contracts';
import type { ApiFailure } from '../../api/client.js';
import { useApiClient } from '../../api/client-context.js';

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

const START: ChatListState = { rows: [], nextCursor: null, first: 'loading', firstFailure: undefined, more: 'idle', moreFailure: undefined };

/**
 * The caller's chats for a search text (none for no search), read again whenever `trigger` changes or `reload` is called. Only the answer of the newest read is applied: a stale one is dropped. A cursor the server no longer accepts
 * (`CURSOR_INVALIDATED`) starts again from the first page, keeping the rows on screen until it answers.
 */
export function useChatList(query: string | undefined, trigger: unknown): { readonly state: ChatListState; readonly reload: () => void; readonly loadMore: () => void } {
  const client = useApiClient();
  const [state, setState] = useState<ChatListState>(START);
  const [reloads, setReloads] = useState(0);
  const generation = useRef(0);
  const held = useRef(state);
  held.current = state;

  const lastQuery = useRef(query);

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    const controller = new AbortController();
    // a reread for the same search keeps as many pages as were shown; a new search starts from its first page
    const keep = lastQuery.current === query ? held.current.rows.length : 0;
    lastQuery.current = query;
    setState((current) => ({ ...current, first: 'loading', firstFailure: undefined, more: 'idle', moreFailure: undefined }));
    const search = query === undefined ? {} : { q: query };
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
      if (mine !== generation.current) return;
      setState((current) => (result.ok ? { rows: result.value.items, nextCursor: result.value.nextCursor, first: 'ready', firstFailure: undefined, more: 'idle', moreFailure: undefined } : { ...current, first: 'failed', firstFailure: result.failure }));
    })();
    return () => controller.abort();
  }, [client, query, trigger, reloads]);

  const reload = useCallback(() => setReloads((count) => count + 1), []);

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

  return { state, reload, loadMore };
}
