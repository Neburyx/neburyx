import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { KEY_SCOPE_ATTRIBUTE } from '../workspace/key-binding-handler.js';
import { CANCEL } from './copy.js';
import { DIALOG_BEHIND_ATTRIBUTE } from './dialog-behind.js';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select, textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface ConfirmDialogProps {
  readonly title: string;
  readonly confirmLabel: string;
  readonly busyLabel: string;
  readonly busy: boolean;
  /** False while what the person typed cannot be sent. */
  readonly canConfirm: boolean;
  /** Where the focus goes when the dialog opens: the safe button, or the first text field. */
  readonly initialFocus: 'cancel' | 'field';
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  /** What a refused or failed call says; announced when it appears. */
  readonly message?: ReactNode;
  readonly children: ReactNode;
  /** While the call is out the dialog cannot be dismissed: Cancel is disabled and Esc, the close button and the scrim do nothing. */
  readonly lockWhileBusy?: boolean;
  /** A click on the scrim outside the dialog dismisses it (unless it is locked). */
  readonly closeOnScrim?: boolean;
  /** No close button in the heading: Cancel and Esc dismiss it. */
  readonly hideClose?: boolean;
  /** Replace the classes of the scrim and of the dialog, for a dialog that has a frame of its own. */
  readonly scrimClassName?: string;
  readonly dialogClassName?: string;
}

/** A modal that asks before something is deleted: the page behind it is inert, Tab stays inside, Esc and Cancel close it, and a call that is going on is not sent twice. */
export function ConfirmDialog({ title, confirmLabel, busyLabel, busy, canConfirm, initialFocus, onConfirm, onClose, message, children, lockWhileBusy = false, closeOnScrim = false, hideClose = false, scrimClassName = 'sheet-scrim rename-scrim', dialogClassName = 'sheet rename-dialog confirm-dialog' }: ConfirmDialogProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  useEffect(() => {
    const behind = document.querySelectorAll(`[${KEY_SCOPE_ATTRIBUTE}="workspace"], [${DIALOG_BEHIND_ATTRIBUTE}]`);
    for (const element of behind) element.setAttribute('inert', '');
    if (initialFocus === 'field') dialog.current?.querySelector<HTMLElement>('textarea, input')?.focus();
    else cancel.current?.focus();
    return () => {
      for (const element of behind) element.removeAttribute('inert');
    };
  }, [initialFocus]);

  const locked = lockWhileBusy && busy;
  const dismiss = (): void => {
    if (!locked) onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className={scrimClassName} onClick={closeOnScrim ? (event) => (event.target === event.currentTarget ? dismiss() : undefined) : undefined}>
      <div ref={dialog} className={dialogClassName} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="rename-title">
          <h2 id={headingId} className="sheet-heading">
            {title}
          </h2>
          {hideClose ? null : (
            <button type="button" className="sheet-close" aria-label="Close" disabled={locked} onClick={onClose}>
              <span aria-hidden="true">✕</span>
            </button>
          )}
        </div>
        <div className="rename-form">
          {children}
          {message === undefined ? null : (
            <p role="alert" className="rename-problem">
              {message}
            </p>
          )}
          <div className="rename-actions">
            <button ref={cancel} type="button" className="secondary" disabled={locked} onClick={onClose}>
              {CANCEL}
            </button>
            <button type="button" className="primary confirm-danger" disabled={!canConfirm || busy} aria-busy={busy ? true : undefined} onClick={onConfirm}>
              {busy ? busyLabel : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
