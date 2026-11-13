import { SAVED_COPY, changeSharedTitle } from '../saved/saved-copy.js';
import { Dialog } from '../../views/dialog.js';

interface Props {
  readonly name: string;
  /** Whether others on the source run the pattern: they are told so, and Save for everyone is offered. */
  readonly shared: boolean;
  readonly busy: boolean;
  /** The version is out of date: Save for everyone would be refused again, so it is not offered. */
  readonly stale: boolean;
  /** What a refused save said; the edits are kept, and Save as a copy stays possible. */
  readonly message: string | undefined;
  readonly onCancel: () => void;
  readonly onCopy: () => void;
  readonly onEveryone: () => void;
}

/** The question before a change of a pattern others run (PB18): Cancel, Save as a copy and Save for everyone; for a private pattern whose save was refused it is the sentence and the same two ways out. */
export function ChangeDialog({ name, shared, busy, stale, message, onCancel, onCopy, onEveryone }: Props) {
  return (
    <Dialog title={changeSharedTitle(name)} onClose={busy ? undefined : onCancel}>
      {() => (
        <div className="rename-form">
          {shared ? <p>{SAVED_COPY.changeSharedLine}</p> : null}
          {message === undefined ? null : (
            <p role="alert" className="rename-problem">
              {message}
            </p>
          )}
          <div className="rename-actions">
            <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
              {SAVED_COPY.cancel}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={onCopy}>
              {SAVED_COPY.saveAsCopy}
            </button>
            {shared && !stale ? (
              <button type="button" className="primary" disabled={busy} aria-busy={busy ? true : undefined} onClick={onEveryone}>
                {busy ? SAVED_COPY.saving : SAVED_COPY.saveForEveryone}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </Dialog>
  );
}
