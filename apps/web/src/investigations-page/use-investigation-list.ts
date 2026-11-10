import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { InvestigationListItem } from '@neburyx/contracts';
import type { ApiClient, ApiFailure, InvestigationPageQuery } from '../api/client.js';

export interface ListFilters {
  readonly status: 'open' | 'closed' | 'archived';
  /** The deleted investigations that can still be restored, of any status. */
  readonly deleted?: boolean;
  readonly sourceId: string | undefined;
  readonly text: string | undefined;
}

export interface ListState {
  /** What is shown: the rows of the pages read, kept while another list is being read or a read fails. */
  readonly items: readonly InvestigationListItem[] | undefined;
  readonly matching: number | undefined;
  /** The library's named views, as the first page said; the tab of the saved views shows it. */
  readonly savedViews: number | undefined;
  readonly nextCursor: string | null;
  /** How many days a deleted investigation stays restorable, as the server's last answer said. */
  readonly retentionDays: number | undefined;
  /** The first page of the filters is being read. */
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly failure: { readonly where: 'first' | 'more'; readonly failure: ApiFailure } | undefined;
  /** The row whose title link takes the focus once it is drawn: the first of the page last appended, or the neighbour of a row that left. */
  readonly focusId: string | undefined;
  /** What the status line says when a row has left the list, until the list changes again. */
  readonly note: string | undefined;
  /** The rows shown all left while more remain on the server: the first page is read again and its first row takes the focus. */
  readonly refocusFirst: boolean;
}

type Action =
  | { readonly type: 'first-started' }
  | { readonly type: 'first-answered'; readonly items: readonly InvestigationListItem[]; readonly matching: number; readonly savedViews: number; readonly nextCursor: string | null; readonly retentionDays: number }
  | { readonly type: 'more-started' }
  | { readonly type: 'more-answered'; readonly items: readonly InvestigationListItem[]; readonly matching: number; readonly nextCursor: string | null }
  | { readonly type: 'failed'; readonly where: 'first' | 'more'; readonly failure: ApiFailure }
  | { readonly type: 'replace-row'; readonly item: InvestigationListItem }
  | { readonly type: 'remove-row'; readonly id: string; readonly note: string }
  | { readonly type: 'focus-taken' };

/** `focusId` when the row that took the focus was the last one: the caption of the table does. */
export const NO_ROW_LEFT = '';

export const INITIAL: ListState = { items: undefined, matching: undefined, savedViews: undefined, nextCursor: null, retentionDays: undefined, loading: true, loadingMore: false, failure: undefined, focusId: undefined, note: undefined, refocusFirst: false };

export function reduceList(state: ListState, action: Action): ListState {
  switch (action.type) {
    case 'first-started':
      return { ...state, loading: true, loadingMore: false, failure: undefined, note: state.refocusFirst ? state.note : undefined };
    case 'first-answered':
      return { items: action.items, matching: action.matching, savedViews: action.savedViews, nextCursor: action.nextCursor, retentionDays: action.retentionDays, loading: false, loadingMore: false, failure: undefined, focusId: state.refocusFirst ? action.items[0]?.id : undefined, note: state.refocusFirst ? state.note : undefined, refocusFirst: false };
    case 'more-started':
      return { ...state, loadingMore: true, failure: undefined };
    case 'more-answered':
      return { ...state, items: [...(state.items ?? []), ...action.items], matching: action.matching, nextCursor: action.nextCursor, loadingMore: false, failure: undefined, focusId: action.items[0]?.id, note: undefined };
    case 'failed':
      return { ...state, loading: false, loadingMore: false, refocusFirst: false, failure: { where: action.where, failure: action.failure } };
    case 'replace-row':
      return { ...state, items: state.items?.map((item) => (item.id === action.item.id ? action.item : item)) };
    case 'remove-row': {
      const rows = state.items ?? [];
      const at = rows.findIndex((item) => item.id === action.id);
      const neighbour = rows[at + 1] ?? rows[at - 1];
      const left = rows.filter((item) => item.id !== action.id);
      return { ...state, items: left, matching: state.matching === undefined ? undefined : Math.max(0, state.matching - 1), note: action.note, focusId: neighbour?.id ?? NO_ROW_LEFT, refocusFirst: left.length === 0 && state.nextCursor !== null };
    }
    case 'focus-taken':
      return { ...state, focusId: undefined };
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

export const querySoFar = (filters: ListFilters): InvestigationPageQuery => ({ ...(filters.deleted === true ? { deleted: true } : { status: filters.status }), ...(filters.sourceId === undefined ? {} : { sourceId: filters.sourceId }), ...(filters.text === undefined ? {} : { text: filters.text }) });

export interface InvestigationList {
  readonly state: ListState;
  readonly showMore: () => void;
  readonly retry: () => void;
  readonly replaceRow: (item: InvestigationListItem) => void;
  readonly removeRow: (id: string, note: string) => void;
  readonly focusTaken: () => void;
}

/** The pages of the caller's investigations for the filters given. A change of the filters reads the first page again and ignores what an earlier read answers late; the rows on screen stay until the new ones come. */
export function useInvestigationList(client: ApiClient, filters: ListFilters): InvestigationList {
  const [state, dispatch] = useReducer(reduceList, INITIAL);
  const generation = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const moreInFlight = useRef(false);
  const latest = useRef(state);
  latest.current = state;
  const { status, sourceId, text, deleted } = filters;

  const loadFirst = useCallback(() => {
    generation.current += 1;
    const mine = generation.current;
    moreInFlight.current = false;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    dispatch({ type: 'first-started' });
    void client.listInvestigationPage(querySoFar({ status, sourceId, text, deleted }), abort.signal).then((result) => {
      if (generation.current !== mine) return;
      if (result.ok) dispatch({ type: 'first-answered', items: result.value.items, matching: result.value.matching.value, savedViews: result.value.counts.savedViews.count.value, nextCursor: result.value.nextCursor, retentionDays: result.value.retention.deletedInvestigationsDays });
      else dispatch({ type: 'failed', where: 'first', failure: result.failure });
    });
  }, [client, status, sourceId, text, deleted]);

  useEffect(() => {
    loadFirst();
    return () => {
      generation.current += 1;
      controller.current?.abort();
    };
  }, [loadFirst]);

  useEffect(() => {
    if (state.refocusFirst && state.items?.length === 0 && !state.loading) loadFirst();
  }, [state.refocusFirst, state.items, state.loading, loadFirst]);

  const showMore = useCallback(() => {
    const held = latest.current;
    if (moreInFlight.current || held.loadingMore || held.loading || held.nextCursor === null) return;
    moreInFlight.current = true;
    const mine = generation.current;
    const cursor = held.nextCursor;
    dispatch({ type: 'more-started' });
    void client.listInvestigationPage({ ...querySoFar({ status, sourceId, text, deleted }), cursor }, controller.current?.signal).then((result) => {
      if (generation.current !== mine) return;
      moreInFlight.current = false;
      if (result.ok) dispatch({ type: 'more-answered', items: result.value.items, matching: result.value.matching.value, nextCursor: result.value.nextCursor });
      else if (result.failure.code === 'CURSOR_INVALIDATED') loadFirst();
      else dispatch({ type: 'failed', where: 'more', failure: result.failure });
    });
  }, [client, status, sourceId, text, deleted, loadFirst]);

  return {
    state,
    showMore,
    retry: loadFirst,
    replaceRow: useCallback((item) => dispatch({ type: 'replace-row', item }), []),
    removeRow: useCallback((id, note) => dispatch({ type: 'remove-row', id, note }), []),
    focusTaken: useCallback(() => dispatch({ type: 'focus-taken' }), []),
  };
}
