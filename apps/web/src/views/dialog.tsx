import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { KEY_SCOPE_ATTRIBUTE } from '../workspace/key-binding-handler.js';
import { CLOSE } from './copy.js';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  readonly title: string;
  /** Called by Esc, the close button and Cancel; a dialog that is busy ignores it by passing `undefined`. */
  readonly onClose: (() => void) | undefined;
  /** The element that takes the focus first; the first control when it is left out. */
  readonly initialFocus?: string;
  readonly children: (titleId: string) => ReactNode;
}

/** A modal dialog over the workspace: it takes the focus, keeps it inside, closes on Esc and gives the focus back to what had it. */
export function Dialog({ title, onClose, initialFocus, children }: DialogProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const returnTo = document.activeElement;
    const behind = document.querySelector(`[${KEY_SCOPE_ATTRIBUTE}="workspace"]`);
    behind?.setAttribute('inert', '');
    const first = initialFocus === undefined ? undefined : dialog.current?.querySelector<HTMLElement>(initialFocus);
    (first ?? dialog.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    return () => {
      behind?.removeAttribute('inert');
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
    };
  }, [initialFocus]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (!(active instanceof HTMLElement) || !dialog.current?.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };

  return createPortal(
    <div
      className="sheet-scrim view-scrim"
      onMouseDown={(event) => {
        // a press outside the dialog must not send the focus to the page body, where the workspace keys would run
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        dialog.current?.focus();
      }}
    >
      <div className="sheet view-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialog} onKeyDown={onKeyDown}>
        <div className="sheet-title">
          <h2 id={titleId} className="sheet-heading">
            {title}
          </h2>
          <button type="button" className="sheet-close" aria-label={CLOSE} disabled={onClose === undefined} onClick={onClose}>
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        {children(titleId)}
      </div>
    </div>,
    document.body,
  );
}
