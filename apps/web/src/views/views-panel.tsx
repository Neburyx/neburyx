import type { NamedView } from '@neburyx/contracts';
import { MAX_VIEW_NAME_LENGTH } from '@neburyx/contracts';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useStoreSelector } from '../state/store.js';
import { CANCEL, FREE_TEXT_HINT, VIEW_DELETE, deleteLabel, LOADING_MORE, MORE_FAILED, NAME_LABEL, NAME_TOO_LONG, NO_VIEWS, READ_ONLY_VIEWS, RENAME, RENAME_CONFLICT, RENAME_FAILED, RESTORE_FOOTNOTE, RESTORE_INTO_DRAFT, RETRY, SAVE_NAME, SHOW_MORE, VIEWS_FAILED, VIEWS_LOADING, VIEWS_TITLE, draftAutosaved, renameLabel, restoreLabel, savedBy, viewsCount } from './copy.js';
import { utcDateTime, utcTime } from './format.js';
import type { ViewList } from './view-list.js';

type RenameProblem = 'failed' | 'conflict';

interface Editing {
  readonly viewId: string;
  readonly name: string;
  readonly saving: boolean;
  readonly problem: RenameProblem | undefined;
}

const charactersIn = (text: string): number => Array.from(text).length;

function RenameRow({ view, editing, readOnly, onChange, onSave, onCancel }: { readonly view: NamedView; readonly editing: Editing; readonly readOnly: boolean; readonly onChange: (name: string) => void; readonly onSave: () => void; readonly onCancel: () => void }) {
  const ids = { input: useId(), hint: useId(), error: useId() };
  const tooLong = charactersIn(editing.name) > MAX_VIEW_NAME_LENGTH;
  const empty = editing.name.trim() === '';
  const message = tooLong ? NAME_TOO_LONG : editing.problem === 'conflict' ? RENAME_CONFLICT : editing.problem === 'failed' ? RENAME_FAILED : '';
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!editing.saving && !empty && !tooLong && !readOnly) onSave();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    // Esc undoes the rename and leaves the panel open
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };
  return (
    <form className="views-rename" onSubmit={submit} onKeyDown={onKeyDown} noValidate>
      <label htmlFor={ids.input} className="visually-hidden">
        {NAME_LABEL}
        {` of ${view.name}`}
      </label>
      <input id={ids.input} type="text" value={editing.name} autoFocus onChange={(event) => onChange(event.target.value)} aria-invalid={message !== ''} aria-describedby={`${ids.hint} ${ids.error}`} />
      <p id={ids.hint} className="views-hint">
        {FREE_TEXT_HINT}
      </p>
      <p id={ids.error} role="status" className="views-error">
        {message}
      </p>
      <div className="views-row-actions">
        <button type="submit" className="link" disabled={editing.saving || empty || tooLong || readOnly} aria-busy={editing.saving}>
          {SAVE_NAME}
        </button>
        <button type="button" className="link" disabled={editing.saving} onClick={onCancel}>
          {CANCEL}
        </button>
      </div>
    </form>
  );
}

export interface ViewsPanelProps {
  readonly list: ViewList;
  /** Whether the investigation is closed or archived: its views are listed and cannot be restored or renamed. */
  readonly readOnly?: boolean;
  readonly titleId: string;
  /** Called to restore a view into the draft; without it the button is shown disabled. */
  readonly onRestore?: ((view: NamedView) => void) | undefined;
  /** Called to delete a view; without it the button is shown disabled. */
  readonly onDelete?: ((view: NamedView, trigger: HTMLElement) => void) | undefined;
  /** What the last delete came to, said in the panel's live region: deleted, already deleted, or changed elsewhere. */
  readonly message?: string | undefined;
  /** After a delete, the view whose Restore into draft button takes the focus, or `empty` for the note of an empty panel; cleared once taken. */
  readonly focusAfter?: string | undefined;
  readonly onFocused?: (() => void) | undefined;
}

/** The body of the Views panel: the draft's autosave time, the named views with Restore into draft, Rename and Delete, and Show more. */
export function ViewsPanel({ list, titleId, onRestore, onDelete, message, focusAfter, onFocused, readOnly = false }: ViewsPanelProps) {
  const state = useStoreSelector(list.state, (current) => current);
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const reasonId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<'conflict' | undefined>(undefined);

  const rename = (current: Editing): void => {
    setEditing({ ...current, saving: true, problem: undefined });
    void list.rename(current.viewId, current.name).then((outcome) => {
      if (outcome === 'renamed') {
        setEditing(undefined);
        return;
      }
      // a conflict reads the list again, so the row shows the name that is there now
      setEditing(outcome === 'conflict' ? undefined : { ...current, saving: false, problem: 'failed' });
      if (outcome === 'conflict') setNotice('conflict');
    });
  };
  useEffect(() => {
    if (focusAfter === undefined || state.kind !== 'ready') return;
    const target = focusAfter === 'empty' ? root.current?.querySelector<HTMLElement>('[data-views-empty]') : root.current?.querySelector<HTMLElement>(`button[data-restore-view="${CSS.escape(focusAfter)}"]`);
    target?.focus();
    onFocused?.();
  }, [focusAfter, state, onFocused]);

  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <>
        <h2 id={titleId} className="views-title">
          {VIEWS_TITLE}
        </h2>
        <p role="status" className="views-note">
          {VIEWS_LOADING}
        </p>
      </>
    );
  }
  if (state.kind === 'failed') {
    return (
      <>
        <h2 id={titleId} className="views-title">
          {VIEWS_TITLE}
        </h2>
        <p role="status" className="views-error">
          {VIEWS_FAILED}
        </p>
        <button type="button" className="secondary" onClick={() => void list.load()}>
          {RETRY}
        </button>
      </>
    );
  }
  return (
    <div ref={root}>
      <h2 id={titleId} className="views-title">
        {viewsCount(state.count)}
      </h2>
      <p className="views-note">{draftAutosaved(utcTime(state.draft.updatedAt))}</p>
      {readOnly ? (
        <p id={reasonId} className="views-note">
          {READ_ONLY_VIEWS}
        </p>
      ) : null}
      {notice === 'conflict' ? (
        <p role="status" className="views-error">
          {RENAME_CONFLICT}
        </p>
      ) : null}
      <p role="status" className={message === undefined ? 'visually-hidden' : 'views-note'}>
        {message ?? ''}
      </p>
      {state.items.length === 0 ? (
        <p role="status" className="views-note" tabIndex={-1} data-views-empty="">
          {NO_VIEWS}
        </p>
      ) : (
        <ul className="views-list">
          {state.items.map((view) => (
            <li key={view.id} className="views-row">
              {editing?.viewId === view.id ? (
                <RenameRow view={view} editing={editing} readOnly={readOnly} onChange={(name) => setEditing({ ...editing, name, problem: undefined })} onSave={() => rename(editing)} onCancel={() => setEditing(undefined)} />
              ) : (
                <>
                  <p className="views-name">{view.name}</p>
                  <p className="views-meta">{savedBy(view.savedBy.name, utcDateTime(view.createdAt))}</p>
                  <div className="views-row-actions">
                    <button type="button" className="link" aria-label={restoreLabel(view.name)} data-restore-view={view.id} aria-describedby={readOnly ? reasonId : undefined} disabled={onRestore === undefined || readOnly} onClick={() => onRestore?.(view)}>
                      {RESTORE_INTO_DRAFT}
                    </button>
                    <button
                      type="button"
                      className="link"
                      aria-label={renameLabel(view.name)}
                      aria-describedby={readOnly ? reasonId : undefined}
                      disabled={readOnly}
                      onClick={() => {
                        setNotice(undefined);
                        setEditing({ viewId: view.id, name: view.name, saving: false, problem: undefined });
                      }}
                    >
                      {RENAME}
                    </button>
                    <button type="button" className="link" aria-label={deleteLabel(view.name)} aria-describedby={readOnly ? reasonId : undefined} disabled={onDelete === undefined || readOnly} onClick={(event) => onDelete?.(view, event.currentTarget)}>
                      {VIEW_DELETE}
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {state.nextCursor === null ? null : (
        <div className="views-more">
          {state.moreFailed ? (
            <p role="status" className="views-error">
              {MORE_FAILED}
            </p>
          ) : null}
          <button type="button" className="secondary" disabled={state.loadingMore} aria-busy={state.loadingMore} onClick={() => void list.more()}>
            {state.loadingMore ? LOADING_MORE : SHOW_MORE}
          </button>
        </div>
      )}
      <p className="views-note">{RESTORE_FOOTNOTE}</p>
    </div>
  );
}
