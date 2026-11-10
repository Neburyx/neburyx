import { MAX_NOTES_LENGTH, MAX_VIEW_NAME_LENGTH } from '@neburyx/contracts';
import { useId, useState, type FormEvent } from 'react';
import { useApiClient } from '../api/client-context.js';
import { useClientState } from '../state/context.js';
import { draftSyncOf } from '../draft/draft-sync.js';
import { useSourceName } from '../shell/use-current-source.js';
import { CANCEL, FREE_TEXT_HINT, NAME_LABEL, NAME_TOO_LONG, NOTE_LABEL, NOTE_PLACEHOLDER, NOTE_TOO_LONG, RELOAD, SAVE_DIALOG_SCOPE, SAVE_DIALOG_TITLE, SAVE_DISCLOSURE, SAVE_FAILED, SAVE_INVESTIGATION, SAVED_ITEMS, SAVED_SOURCE_LABEL, SAVING, TITLE_CONFLICT, WHAT_IS_SAVED } from './copy.js';
import { Dialog } from './dialog.js';
import { saveNamedView } from './save-view.js';

type Failure = 'failed' | 'title-conflict';

const charactersIn = (text: string): number => Array.from(text).length;
const reloadPage = (): void => window.location.reload();

interface FormProps {
  readonly title: string;
  readonly notes: string | null;
  readonly sourceId: string | null;
  readonly busy: boolean;
  readonly failure: Failure | undefined;
  readonly onCancel: () => void;
  readonly onSubmit: (name: string, notes: string) => void;
  readonly reload: () => void;
}

function SaveForm({ title, notes, sourceId, busy, failure, onCancel, onSubmit, reload }: FormProps) {
  const [name, setName] = useState(title);
  const [note, setNote] = useState(notes ?? '');
  const ids = { nameHint: useId(), noteHint: useId(), nameError: useId(), noteError: useId(), status: useId() };
  const tooLong = charactersIn(name) > MAX_VIEW_NAME_LENGTH;
  const noteTooLong = charactersIn(note) > MAX_NOTES_LENGTH;
  const empty = name.trim() === '';
  const nameProblem = tooLong ? NAME_TOO_LONG : failure === 'title-conflict' ? TITLE_CONFLICT : undefined;
  const sourceName = useSourceName(sourceId ?? '');
  const canSave = !busy && !empty && !tooLong && !noteTooLong;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (canSave) onSubmit(name, note);
  };
  return (
    <form className="view-form" onSubmit={submit} noValidate>
      <p className="view-scope">{SAVE_DIALOG_SCOPE}</p>
      <div className="view-field">
        <label htmlFor={ids.nameHint + '-name'}>{NAME_LABEL}</label>
        <input id={ids.nameHint + '-name'} type="text" value={name} onChange={(event) => setName(event.target.value)} aria-invalid={nameProblem !== undefined} aria-describedby={[ids.nameHint, nameProblem === undefined ? undefined : ids.nameError].filter((id) => id !== undefined).join(' ')} />
        <p id={ids.nameHint} className="view-hint">
          {FREE_TEXT_HINT}
        </p>
        <p id={ids.nameError} role="status" className="view-error">
          {nameProblem ?? ''}
        </p>
      </div>
      <div className="view-field">
        <label htmlFor={ids.noteHint + '-note'}>{NOTE_LABEL}</label>
        <textarea id={ids.noteHint + '-note'} value={note} placeholder={NOTE_PLACEHOLDER} rows={3} onChange={(event) => setNote(event.target.value)} aria-invalid={noteTooLong} aria-describedby={noteTooLong ? `${ids.noteHint} ${ids.noteError}` : ids.noteHint} />
        <p id={ids.noteHint} className="view-hint">
          {FREE_TEXT_HINT}
        </p>
        <p id={ids.noteError} role="status" className="view-error">
          {noteTooLong ? NOTE_TOO_LONG : ''}
        </p>
      </div>
      <section className="view-saved" aria-label={WHAT_IS_SAVED}>
        <h3>{WHAT_IS_SAVED}</h3>
        <ul>
          <li>
            {SAVED_SOURCE_LABEL} · {sourceName}
          </li>
          {SAVED_ITEMS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
      <p className="view-disclosure">{SAVE_DISCLOSURE}</p>
      <div id={ids.status} role="status" className={failure === 'failed' ? 'view-error' : 'visually-hidden'}>
        {failure === 'failed' ? SAVE_FAILED : busy ? SAVING : ''}
      </div>
      {failure === 'title-conflict' ? (
        <button type="button" className="secondary view-reload" onClick={reload}>
          {RELOAD}
        </button>
      ) : null}
      <div className="view-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          {CANCEL}
        </button>
        <button type="submit" className="primary" disabled={!canSave} aria-busy={busy}>
          {SAVE_INVESTIGATION}
        </button>
      </div>
    </form>
  );
}

export interface SaveDialogProps {
  readonly onClose: () => void;
  readonly reload?: () => void;
}

/** The Save investigation dialog (13A): a name and a note, saved with the draft as a named view in one call. */
export function SaveDialog({ onClose, reload = reloadPage }: SaveDialogProps) {
  const client = useApiClient();
  const state = useClientState();
  const [opened] = useState(() => {
    const { id, record, sourceId } = state.investigation.getState();
    return { record, sourceId, notes: id === null ? null : (draftSyncOf(state, client).stateOf(id)?.notes ?? null) };
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const { record, sourceId, notes } = opened;
  if (record === null) return null;
  const submit = (name: string, notes: string): void => {
    setBusy(true);
    setFailure(undefined);
    void saveNamedView(client, state, { name, notes: notes === '' ? null : notes }).then((outcome) => {
      setBusy(false);
      if (outcome.kind === 'saved' || outcome.kind === 'changed-elsewhere') {
        onClose();
        return;
      }
      setFailure(outcome.kind);
    });
  };
  return (
    <Dialog title={SAVE_DIALOG_TITLE} initialFocus="input" onClose={busy ? undefined : onClose}>
      {() => <SaveForm title={record.title} notes={notes} sourceId={sourceId} busy={busy} failure={failure} onCancel={onClose} onSubmit={submit} reload={reload} />}
    </Dialog>
  );
}
