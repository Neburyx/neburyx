import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_PATTERN_LIST_LIMIT, type ListedPattern } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../../api/client.js';
import { UNEXPECTED } from '../../api/use-request.js';

export type SavedListState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'failed'; readonly failure: ApiFailure }
  | {
      readonly phase: 'ready';
      readonly items: readonly ListedPattern[];
      /** The cursor of the next page, or `null` when the list is whole. */
      readonly nextCursor: string | null;
      readonly loadingMore: boolean;
      /** What the last Load more could not do; the rows already read stay. */
      readonly moreFailure: ApiFailure | undefined;
      /** Set when the list was read again from its first page because a cursor was refused. */
      readonly cursorReset: boolean;
    };

export interface SavedList {
  readonly state: SavedListState;
  readonly loadMore: () => void;
  /** Reads the list again from its first page, keeping the rows on screen until the answer arrives. */
  readonly reload: () => void;
}

/**
 * The saved patterns of a source, read a page at a time: the first page on mount and on `reload`, the next on `loadMore` with the cursor the server gave. An answer to a read that was replaced, or that
 * belongs to a source that has gone, is never shown (every read is aborted by the next and by leaving).
 */
export function useSavedPatterns(client: ApiClient, sourceId: string | null): SavedList {
  const [state, setState] = useState<SavedListState>({ phase: 'loading' });
  const newest = useRef<AbortController | undefined>(undefined);
  const held = useRef(state);
  held.current = state;

  const readFirst = useCallback(
    (cursorReset: boolean) => {
      newest.current?.abort();
      if (sourceId === null) return;
      const controller = new AbortController();
      newest.current = controller;
      const send = async (): Promise<void> => {
        let result: Awaited<ReturnType<ApiClient['listPatterns']>>;
        try {
          result = await client.listPatterns({ sourceId, limit: DEFAULT_PATTERN_LIST_LIMIT }, controller.signal);
        } catch {
          result = UNEXPECTED;
        }
        if (newest.current !== controller) return;
        if (!result.ok) {
          if (result.failure.code === 'ABORTED') return;
          setState((now) => (now.phase === 'ready' ? { ...now, loadingMore: false, moreFailure: result.failure } : { phase: 'failed', failure: result.failure }));
          return;
        }
        setState({ phase: 'ready', items: result.value.items, nextCursor: result.value.nextCursor, loadingMore: false, moreFailure: undefined, cursorReset });
      };
      void send();
    },
    [client, sourceId],
  );

  useEffect(() => {
    setState({ phase: 'loading' });
    readFirst(false);
    return () => newest.current?.abort();
  }, [readFirst]);

  const loadMore = useCallback(() => {
    const now = held.current;
    if (sourceId === null || now.phase !== 'ready' || now.nextCursor === null || now.loadingMore) return;
    const cursor = now.nextCursor;
    newest.current?.abort();
    const controller = new AbortController();
    newest.current = controller;
    setState({ ...now, loadingMore: true, moreFailure: undefined, cursorReset: false });
    const send = async (): Promise<void> => {
      let result: Awaited<ReturnType<ApiClient['listPatterns']>>;
      try {
        result = await client.listPatterns({ sourceId, limit: DEFAULT_PATTERN_LIST_LIMIT, cursor }, controller.signal);
      } catch {
        result = UNEXPECTED;
      }
      if (newest.current !== controller) return;
      if (!result.ok) {
        if (result.failure.code === 'ABORTED') return;
        if (result.failure.code === 'CURSOR_INVALIDATED') {
          readFirst(true);
          return;
        }
        setState({ ...now, loadingMore: false, moreFailure: result.failure, cursorReset: false });
        return;
      }
      setState({ phase: 'ready', items: [...now.items, ...result.value.items], nextCursor: result.value.nextCursor, loadingMore: false, moreFailure: undefined, cursorReset: false });
    };
    void send();
  }, [client, sourceId, readFirst]);

  const reload = useCallback(() => readFirst(false), [readFirst]);
  return { state, loadMore, reload };
}
