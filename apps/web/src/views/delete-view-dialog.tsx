import { notesSchema, MAX_NOTES_LENGTH } from '@neburyx/contracts';
import { useId, useState } from 'react';
import type { ApiFailure } from '../api/client.js';
import { ConfirmDialog } from '../lifecycle/confirm-dialog.js';
import { messageOf } from '../lifecycle/status-flow.js';
import { TITLE_INVALID } from '../lifecycle/copy.js';
import type { RemoveOutcome } from './view-list.js';
import { DELETE_VIEW, DELETE_VIEW_TEXT, DELETING_VIEW, FREE_TEXT_HINT, NOTE_LABEL, NOTE_TOO_LONG } from './copy.js';

export interface DeleteViewDialogProps {
  readonly title: string;
  /** Sends the delete with the note, or `null` when none was typed. */
  readonly send: (note: string | null) => Promise<RemoveOutcome>;
  readonly onDeleted: () => void;
  /** The view was changed elsewhere (a stale version): the dialog closes and the list is read again. */
  readonly onChangedElsewhere: () => void;
  /** The view is already deleted: the dialog closes and the row goes. */
  readonly onGone: () => void;
  readonly onClose: () => void;
}

const charactersIn = (text: string): number => Array.from(text).length;

/** The confirm that asks before a named view is deleted, with a note, kept with the view, that says why. A failure that can be tried again keeps the dialog and the typed note. */
export function DeleteViewDialog({ title, send, onDeleted, onChangedElsewhere, onGone, onClose }: DeleteViewDialogProps) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);
  const hintId = useId();
  const problemId = useId();
  const tooLong = charactersIn(note) > MAX_NOTES_LENGTH;
  const unstorable = !tooLong && !notesSchema.safeParse(note).success;
  const problem = tooLong ? NOTE_TOO_LONG : unstorable ? TITLE_INVALID : undefined;

  const confirm = async (): Promise<void> => {
    if (busy || problem !== undefined) return;
    setBusy(true);
    setFailure(undefined);
    const result = await send(note === '' ? null : note);
    if (result.kind === 'deleted') {
      onDeleted();
      onClose();
      return;
    }
    if (result.kind === 'changed-elsewhere') {
      onChangedElsewhere();
      onClose();
      return;
    }
    if (result.kind === 'gone') {
      onGone();
      onClose();
      return;
    }
    setBusy(false);
    setFailure(result.kind === 'failed' ? result.failure : { code: 'NETWORK_UNAVAILABLE' });
  };

  const fieldId = `${hintId}-note`;
  return (
    <ConfirmDialog
      title={title}
      confirmLabel={DELETE_VIEW}
      busyLabel={DELETING_VIEW}
      busy={busy}
      canConfirm={problem === undefined}
      initialFocus="field"
      onConfirm={() => void confirm()}
      onClose={onClose}
      message={failure === undefined ? undefined : messageOf(failure)}
    >
      <p>{DELETE_VIEW_TEXT}</p>
      <label htmlFor={fieldId}>{NOTE_LABEL}</label>
      <textarea id={fieldId} rows={3} value={note} aria-invalid={problem === undefined ? undefined : true} aria-describedby={`${hintId}${problem === undefined ? '' : ` ${problemId}`}`} onChange={(event) => setNote(event.target.value)} />
      <p id={hintId} className="rename-hint">
        {FREE_TEXT_HINT}
      </p>
      {problem === undefined ? null : (
        <p id={problemId} className="rename-problem">
          {problem}
        </p>
      )}
    </ConfirmDialog>
  );
}
