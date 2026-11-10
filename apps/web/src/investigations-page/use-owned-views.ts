import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { OwnedView } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';

export interface OwnedViewsState {
  readonly items: readonly OwnedView[] | undefined;
  readonly count: number | undefined;
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly failure: { readonly where: 'first' | 'more'; readonly failure: ApiFailure } | undefined;
  /** The first view of the page last appended, which takes the focus once it is drawn. */
  readonly focusId: string | undefined;
}

type Action =
  | { readonly type: 'first-started' }
  | { readonly type: 'first-answered'; readonly items: readonly OwnedView[]; readonly count: number; readonly nextCursor: string | null }
  | { readonly type: 'more-started' }
  | { readonly type: 'more-answered'; readonly items: readonly OwnedView[]; readonly count: number; readonly nextCursor: string | null }
  | { readonly type: 'failed'; readonly where: 'first' | 'more'; readonly failure: ApiFailure }
  | { readonly type: 'focus-taken' };

const INITIAL: OwnedViewsState = { items: undefined, count: undefined, nextCursor: null, loading: true, loadingMore: false, failure: undefined, focusId: undefined };

export function reduceViews(state: OwnedViewsState, action: Action): OwnedViewsState {
  switch (action.type) {
    case 'first-started':
      return { ...state, loading: true, loadingMore: false, failure: undefined };
    case 'first-answered':
      return { items: action.items, count: action.count, nextCursor: action.nextCursor, loading: false, loadingMore: false, failure: undefined, focusId: undefined };
    case 'more-started':
      return { ...state, loadingMore: true, failure: undefined };
    case 'more-answered':
      return { ...state, items: [...(state.items ?? []), ...action.items], count: action.count, nextCursor: action.nextCursor, loadingMore: false, failure: undefined, focusId: action.items[0]?.id };
    case 'failed':
      return { ...state, loading: false, loadingMore: false, failure: { where: action.where, failure: action.failure } };
    case 'focus-taken':
      return { ...state, focusId: undefined };
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

export interface OwnedViews {
  readonly state: OwnedViewsState;
  readonly showMore: () => void;
  readonly retry: () => void;
  readonly focusTaken: () => void;
}

/** The pages of the caller's named views across their investigations, newest first. */
export function useOwnedViews(client: ApiClient): OwnedViews {
  const [state, dispatch] = useReducer(reduceViews, INITIAL);
  const generation = useRef(0);
  const moreInFlight = useRef(false);
  const latest = useRef(state);
  latest.current = state;

  const loadFirst = useCallback(() => {
    generation.current += 1;
    const mine = generation.current;
    moreInFlight.current = false;
    dispatch({ type: 'first-started' });
    void client.listOwnedViews({}).then((result) => {
      if (generation.current !== mine) return;
      if (result.ok) dispatch({ type: 'first-answered', items: result.value.items, count: result.value.count.value, nextCursor: result.value.nextCursor });
      else dispatch({ type: 'failed', where: 'first', failure: result.failure });
    });
  }, [client]);

  useEffect(() => {
    loadFirst();
    return () => {
      generation.current += 1;
    };
  }, [loadFirst]);

  const showMore = useCallback(() => {
    const held = latest.current;
    if (moreInFlight.current || held.loading || held.loadingMore || held.nextCursor === null) return;
    moreInFlight.current = true;
    const mine = generation.current;
    dispatch({ type: 'more-started' });
    void client.listOwnedViews({ cursor: held.nextCursor }).then((result) => {
      if (generation.current !== mine) return;
      moreInFlight.current = false;
      if (result.ok) dispatch({ type: 'more-answered', items: result.value.items, count: result.value.count.value, nextCursor: result.value.nextCursor });
      else if (result.failure.code === 'CURSOR_INVALIDATED') loadFirst();
      else dispatch({ type: 'failed', where: 'more', failure: result.failure });
    });
  }, [client, loadFirst]);

  return { state, showMore, retry: loadFirst, focusTaken: useCallback(() => dispatch({ type: 'focus-taken' }), []) };
}
