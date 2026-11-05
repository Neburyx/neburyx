import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { KEY_SCOPE_ATTRIBUTE } from './key-binding-handler.js';
import { useKeyBindingRegistry, useKeyBindings, type KeyGroup } from './key-binding-registry.js';
import { matchesKeys } from './key-spec.js';

export const SHEET_TITLE = 'Keyboard shortcuts';
export const SHEET_FOOTNOTE = 'Shortcuts work on the selected node or relationship. Nothing loads until you choose it.';
export const SHORTCUTS_BINDING_ID = 'shortcuts';

const GROUPS: readonly { readonly id: KeyGroup; readonly title: string }[] = [
  { id: 'tools', title: 'TOOLS' },
  { id: 'selection', title: 'SELECTION' },
  { id: 'actions', title: 'ACTIONS' },
  { id: 'view', title: 'VIEW' },
];

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function Sheet() {
  const state = useClientState();
  const registry = useKeyBindingRegistry();
  const bindings = useKeyBindings();
  const dialog = useRef<HTMLDivElement>(null);
  const title = useId();
  const close = (): void => state.presentation.setSheetOpen(false);

  useEffect(() => {
    const returnTo = document.activeElement;
    const behind = document.querySelector(`[${KEY_SCOPE_ATTRIBUTE}="workspace"]`);
    behind?.setAttribute('inert', '');
    dialog.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      behind?.removeAttribute('inert');
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    const opener = bindings.find((binding) => binding.id === SHORTCUTS_BINDING_ID);
    if (opener?.specs.some((spec) => matchesKeys(spec, event, registry.platform)) === true) {
      event.preventDefault();
      close();
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
    } else if (!(active instanceof HTMLElement) || active === dialog.current || !dialog.current?.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };

  return (
    <div
      className="sheet-scrim"
      onMouseDown={(event) => {
        // a press outside the dialog must not send the focus to the page body, where the workspace keys would run
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        dialog.current?.focus();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={title} tabIndex={-1} ref={dialog} onKeyDown={onKeyDown}>
        <div className="sheet-title">
          <h2 id={title} className="sheet-heading">
            {SHEET_TITLE}
          </h2>
          <button type="button" className="sheet-close" aria-label="Close" onClick={close}>
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className="sheet-columns">
          {GROUPS.map((group) => {
            const rows = bindings.filter((binding) => binding.group === group.id);
            if (rows.length === 0) return null;
            return (
              <section key={group.id} className="sheet-group" aria-label={group.title}>
                <h3 className="sheet-group-title" aria-hidden="true">
                  {group.title}
                </h3>
                {rows.map((binding) => (
                  <div key={binding.id} className="sheet-row">
                    <span className="sheet-label">{binding.label}</span>
                    <span className="sheet-keys">
                      {binding.shown.map((shown) => (
                        <kbd key={shown} className="sheet-key">
                          {shown}
                        </kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
        <p className="sheet-footnote">{SHEET_FOOTNOTE}</p>
      </div>
    </div>
  );
}

/** The dialog that lists the registered key bindings, opened by its own binding and closed by Esc, its close button or the same keys again. */
export function ShortcutSheet() {
  const state = useClientState();
  const open = useStoreSelector(state.presentation.view, (current) => current.sheetOpen);
  return open ? createPortal(<Sheet />, document.body) : null;
}
