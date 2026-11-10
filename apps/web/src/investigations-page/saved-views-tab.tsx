import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useApiClient } from '../api/client-context.js';
import { canRetry, FailureNotice } from '../failure-notice.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { utcDateTime } from '../views/format.js';
import { COLUMN_SOURCE, COULD_NOT_READ_VIEWS, LOADING, LOADING_MORE, MORE_FAILED, NO_VIEWS, SAVED_VIEWS_LABEL, SHOW_MORE, TRY_AGAIN, VIEWS_FOOTNOTE, VIEW_INVESTIGATION, VIEW_NAME, VIEW_SAVED_AT, VIEW_SAVED_BY, openView, showing } from './copy.js';
import { intentOf } from './restore-intent.js';
import { useOwnedViews } from './use-owned-views.js';

/** The named views of all the caller's investigations, newest first, each with an Open that leads to the investigation and asks before the view replaces the draft. */
export function SavedViewsTab() {
  const client = useApiClient();
  const navigate = useNavigate();
  const { state, showMore, retry, focusTaken } = useOwnedViews(client);
  const table = useRef<HTMLTableElement>(null);

  useEffect(() => {
    if (state.focusId === undefined) return;
    table.current?.querySelector<HTMLElement>(`button[data-view-open="${CSS.escape(state.focusId)}"]`)?.focus();
    focusTaken();
  }, [state.focusId, focusTaken]);

  const items = state.items;
  return (
    <div className="investigations-views">
      <p role="status" className="investigations-status">
        {items === undefined ? (state.failure === undefined ? LOADING : '') : items.length === 0 ? '' : state.count === undefined ? '' : showing(items.length, state.count)}
      </p>
      {state.failure === undefined ? null : (
        <div className="investigations-failure">
          <p>{state.failure.where === 'more' ? MORE_FAILED : COULD_NOT_READ_VIEWS}</p>
          <FailureNotice failure={state.failure.failure} />
          {canRetry(state.failure.failure) ? (
            <button type="button" className="secondary" onClick={state.failure.where === 'more' ? showMore : retry}>
              {TRY_AGAIN}
            </button>
          ) : null}
        </div>
      )}
      {items === undefined ? null : items.length === 0 ? (
        <p>{NO_VIEWS}</p>
      ) : (
        <>
          <div className="investigations-table-wrap">
            <table ref={table} className="investigations-table" aria-busy={state.loading ? true : undefined}>
              <caption className="visually-hidden">{SAVED_VIEWS_LABEL}</caption>
              <colgroup>
                <col className="investigations-view-col-name" />
                <col className="investigations-view-col-investigation" />
                <col className="investigations-view-col-source" />
                <col className="investigations-view-col-saved-by" />
                <col className="investigations-view-col-saved-at" />
                <col className="investigations-view-col-open" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">{VIEW_NAME}</th>
                  <th scope="col">{VIEW_INVESTIGATION}</th>
                  <th scope="col">{COLUMN_SOURCE}</th>
                  <th scope="col">{VIEW_SAVED_BY}</th>
                  <th scope="col">{VIEW_SAVED_AT}</th>
                  <th scope="col">
                    <span className="visually-hidden">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((view) => (
                  <tr key={view.id}>
                    <td>{view.name}</td>
                    <td>{view.investigation.title}</td>
                    <td>{view.investigation.sourceAlias}</td>
                    <td>{view.savedBy.name}</td>
                    <td>
                      <time dateTime={view.createdAt}>{utcDateTime(view.createdAt)}</time>
                    </td>
                    <td className="investigations-actions">
                      <button type="button" className="secondary" data-view-open={view.id} aria-label={openView(view.name, view.investigation.title)} onClick={() => void navigate(`${EXPLORE_PATH}/${view.investigation.id}`, { state: intentOf(view) })}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state.nextCursor === null ? null : (
            <button type="button" className="secondary investigations-more" aria-busy={state.loadingMore ? true : undefined} onClick={showMore}>
              {state.loadingMore ? LOADING_MORE : SHOW_MORE}
            </button>
          )}
        </>
      )}
      <p className="investigations-footnote">{VIEWS_FOOTNOTE}</p>
    </div>
  );
}
