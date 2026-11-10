import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { ApiClient } from '../api/client.js';
import { useBanner } from '../banner/banner-context.js';
import { useClientState } from '../state/context.js';
import type { InvestigationStatus } from '../state/investigation-state.js';
import { useStoreSelector } from '../state/store.js';
import { ARCHIVE, CLOSE, MENU_BUTTON_LABEL, MENU_LABEL, RENAME, RENAME_DISABLED, REOPEN } from './copy.js';
import { RenameDialog } from './rename-dialog.js';
import { changeStatus, statusChangeBusy } from './status-flow.js';

interface Item {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled: boolean;
  readonly run: () => void;
}

/** The "···" menu next to the title: Rename, Close and Archive of an open investigation, Reopen and Archive of a closed one, Reopen of an archived one, with Rename disabled while it cannot be changed. */
export function InvestigationMenu({ client }: { readonly client: ApiClient }) {
  const state = useClientState();
  const banner = useBanner();
  const status = useStoreSelector(state.investigation, (held) => held.record?.status);
  const busy = useStoreSelector(statusChangeBusy(state), (value) => value);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const descriptionId = useId();

  const closeMenu = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    panel.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && (panel.current?.contains(event.target) === true || button.current?.contains(event.target) === true)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  if (status === undefined) return null;
  const editable = status === 'open';
  const move = (target: InvestigationStatus) => (): void => {
    closeMenu(true);
    void changeStatus({ client, state, banner }, target);
  };
  const items: readonly Item[] = [
    { id: 'rename', label: RENAME, ...(editable ? {} : { description: RENAME_DISABLED }), disabled: !editable, run: () => { closeMenu(false); setRenaming(true); } },
    ...(editable ? [] : [{ id: 'reopen', label: REOPEN, disabled: busy, run: move('open') }]),
    ...(editable ? [{ id: 'close', label: CLOSE, disabled: busy, run: move('closed') }] : []),
    ...(status === 'archived' ? [] : [{ id: 'archive', label: ARCHIVE, disabled: busy, run: move('archived') }]),
  ];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const rows = [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = rows.findIndex((row) => row === document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : event.key === 'ArrowDown' ? (at + 1) % rows.length : (at - 1 + rows.length) % rows.length;
    rows[next]?.focus();
  };

  return (
    <div className="investigation-menu">
      <button ref={button} type="button" className="investigation-menu-button" aria-label={MENU_BUTTON_LABEL} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen((was) => !was)}>
        <span aria-hidden="true">···</span>
      </button>
      {open ? (
        <div ref={panel} id={menuId} className="menu-panel investigation-menu-panel" role="menu" aria-label={MENU_LABEL} onKeyDown={onKeyDown}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={item.disabled ? 'menu-row menu-row-disabled' : 'menu-row'}
              aria-disabled={item.disabled ? true : undefined}
              aria-describedby={item.description === undefined ? undefined : descriptionId}
              onClick={() => {
                if (!item.disabled) item.run();
              }}
            >
              <span className="menu-label">{item.label}</span>
              {item.description === undefined ? null : (
                <span id={descriptionId} className="menu-hint">
                  {item.description}
                </span>
              )}
            </button>
          ))}
        </div>
      ) : null}
      {renaming ? <RenameDialog client={client} onClose={() => { setRenaming(false); button.current?.focus(); }} /> : null}
    </div>
  );
}
