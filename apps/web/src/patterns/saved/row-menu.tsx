import { useEffect, useId, useRef, useState } from 'react';
import { SAVED_COPY } from './saved-copy.js';

export interface MenuItem {
  readonly key: string;
  readonly label: string;
  readonly onChoose: () => void;
}

interface Props {
  /** The pattern the menu is for, so that its name tells which row it belongs to. */
  readonly name: string;
  readonly items: readonly MenuItem[];
}

/** The "⋯" menu of a row: Enter or Space opens it, the arrow keys move, Enter chooses, Escape closes it and gives the focus back to the button (the panel's own Escape is not reached). */
export function RowMenu({ name, items }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return undefined;
    const menu = list.current;
    menu?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (event: MouseEvent): void => {
      if (event.target instanceof Node && !menu?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false);
    };
    // a native listener: the panel listens for Escape on its frame, above the menu, and this one must be reached first
    const onKeyDown = (event: KeyboardEvent): void => {
      const entries = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      const at = entries.findIndex((entry) => entry === document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        entries[(at + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length]?.focus();
      } else if (event.key === 'Tab') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', away);
    menu?.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', away);
      menu?.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <span className="pattern-row-menu">
      <button ref={trigger} type="button" className="secondary" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={`${SAVED_COPY.menu}: ${name}`} onClick={() => setOpen((now) => !now)}>
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <div id={id} ref={list} role="menu" aria-label={name} className="pattern-menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className="pattern-menu-item"
              onClick={() => {
                // the focused item goes with the menu: the button takes the focus first, so that a dialog gives it back to the button
                trigger.current?.focus();
                setOpen(false);
                item.onChoose();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
