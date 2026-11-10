import { useEffect, useId, useRef, useState } from 'react';
import type { OwnedView } from '@neburyx/contracts';
import { DeleteViewDialog } from '../views/delete-view-dialog.js';
import type { RemoveOutcome } from '../views/view-list.js';
import { VIEW_ALREADY_DELETED, VIEW_DELETED, RENAME_CONFLICT, deleteViewFromTitle } from '../views/copy.js';
import { useNavigate } from 'react-router';
import { useApiClient } from '../api/client-context.js';
import { canRetry, FailureNotice } from '../failure-notice.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { utcDateTime } from '../views/format.js';
import { VIEW_DELETE_ACTION, deleteViewLabel, viewsReadOnlyReason, COLUMN_SOURCE, COULD_NOT_READ_VIEWS, LOADING, LOADING_MORE, MORE_FAILED, NO_VIEWS, SAVED_VIEWS_LABEL, SHOW_MORE, TRY_AGAIN, VIEWS_FOOTNOTE, VIEW_INVESTIGATION, VIEW_NAME, VIEW_SAVED_AT, VIEW_SAVED_BY, openView, showing } from './copy.js';
import { intentOf } from './restore-intent.js';
import { NO_VIEW_LEFT, useOwnedViews } from './use-owned-views.js';

/** The named views of all the caller's investigations, newest first, each with an Open that leads to the investigation and asks before the view replaces the draft. */
export function SavedViewsTab({ onViewDeleted }: { /** A view was deleted from this tab: the count in the tab's name goes down by one. */ readonly onViewDeleted?: (() => void) | undefined } = {}) {
  const client = useApiClient();
  const navigate = useNavigate();
  const { state, showMore, retry, focusTaken, removeRow, setNote } = useOwnedViews(client);
  const table = useRef<HTMLTableElement>(null);
  const caption = useRef<HTMLTableCaptionElement>(null);
  const [deleting, setDeleting] = useState<OwnedView | undefined>(undefined);
  const reasonId = useId();
  const deleteButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (state.focusId === undefined) return;
    if (state.focusId === NO_VIEW_LEFT) caption.current?.focus();
    else table.current?.querySelector<HTMLElement>(`button[data-view-open="${CSS.escape(state.focusId)}"]`)?.focus();
    focusTaken();
  }, [state.focusId, focusTaken]);

  const remove = async (view: OwnedView, note: string | null): Promise<RemoveOutcome> => {
    const result = await client.deleteView(view.investigation.id, view.id, view.version, note);
    if (result.ok) return { kind: 'deleted' };
    if (result.failure.code === 'CONFLICTED_VIEW_VERSION') {
      retry();
      return { kind: 'changed-elsewhere' };
    }
    if (result.failure.code === 'NOT_FOUND') {
      retry();
      return { kind: 'gone' };
    }
    return { kind: 'failed', failure: result.failure };
  };

  const items = state.items;
  return (
    <div className="investigations-views">
      <p role="status" className="investigations-status">
        {state.note ?? (items === undefined ? (state.failure === undefined ? LOADING : '') : items.length === 0 ? '' : state.count === undefined ? '' : showing(items.length, state.count))}
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
              <caption ref={caption} tabIndex={-1} className="visually-hidden">
                {SAVED_VIEWS_LABEL}
              </caption>
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
                    <td>
                      {view.name}
                      {view.investigation.status === 'open' ? null : (
                        <span id={`${reasonId}-${view.id}`} className="investigations-reason">
                          {viewsReadOnlyReason(view.investigation.status)}
                        </span>
                      )}
                    </td>
                    <td>{view.investigation.title}</td>
                    <td>{view.investigation.sourceAlias}</td>
                    <td>{view.savedBy.name}</td>
                    <td>
                      <time dateTime={view.createdAt}>{utcDateTime(view.createdAt)}</time>
                    </td>
                    <td className="investigations-actions">
                      <div className="investigations-view-actions">
                        <button type="button" className="secondary" data-view-open={view.id} aria-label={openView(view.name, view.investigation.title)} onClick={() => void navigate(`${EXPLORE_PATH}/${view.investigation.id}`, { state: intentOf(view) })}>
                          Open
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          aria-label={deleteViewLabel(view.name, view.investigation.title)}
                          aria-describedby={view.investigation.status === 'open' ? undefined : `${reasonId}-${view.id}`}
                          disabled={view.investigation.status !== 'open'}
                          onClick={(event) => {
                            deleteButton.current = event.currentTarget;
                            setDeleting(view);
                          }}
                        >
                          {VIEW_DELETE_ACTION}
                        </button>
                      </div>
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
      {deleting === undefined ? null : (
        <DeleteViewDialog
          title={deleteViewFromTitle(deleting.name, deleting.investigation.title)}
          send={(note) => remove(deleting, note)}
          onDeleted={() => {
            removeRow(deleting.id, VIEW_DELETED);
            onViewDeleted?.();
          }}
          onChangedElsewhere={() => setNote(RENAME_CONFLICT)}
          onGone={() => setNote(VIEW_ALREADY_DELETED)}
          onClose={() => {
            setDeleting(undefined);
            const button = deleteButton.current;
            if (button?.isConnected === true) button.focus();
          }}
        />
      )}
    </div>
  );
}
