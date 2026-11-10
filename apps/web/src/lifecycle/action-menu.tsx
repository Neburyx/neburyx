import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

export interface ActionMenuItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled: boolean;
  /** Red, and set apart from the items before it. */
  readonly tone?: 'danger';
  /** Runs when the item is chosen; `close` shuts the menu, with or without giving the focus back to its button. */
  readonly run: (close: (restoreFocus: boolean) => void) => void;
}

export interface ActionMenuProps {
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
  readonly buttonLabel: string;
  readonly menuLabel: string;
  readonly items: readonly ActionMenuItem[];
  /** `end` opens the panel towards the left, for a menu at the right edge of a row. */
  readonly align?: 'start' | 'end';
}

/** A "···" button with a menu: arrows, Home and End move, Esc closes and returns the focus to the button, Tab leaves, and a disabled item says why. */
export function ActionMenu({ buttonRef, buttonLabel, menuLabel, items, align = 'start' }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const descriptionId = useId();

  const closeMenu = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    panel.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && (panel.current?.contains(event.target) === true || buttonRef.current?.contains(event.target) === true)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, buttonRef]);

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
      <button ref={buttonRef} type="button" className="investigation-menu-button" aria-label={buttonLabel} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen((was) => !was)}>
        <span aria-hidden="true">···</span>
      </button>
      {open ? (
        <div ref={panel} id={menuId} className={`menu-panel investigation-menu-panel${align === 'end' ? ' investigation-menu-panel-end' : ''}`} role="menu" aria-label={menuLabel} onKeyDown={onKeyDown}>
          {items.map((item) => (
            <Fragment key={item.id}>
            {item.tone === 'danger' ? <div role="separator" className="menu-separator" /> : null}
            <button
              type="button"
              role="menuitem"
              className={`menu-row${item.disabled ? ' menu-row-disabled' : ''}${item.tone === 'danger' ? ' menu-row-danger' : ''}`}
              aria-disabled={item.disabled ? true : undefined}
              aria-describedby={item.description === undefined ? undefined : descriptionId}
              onClick={() => {
                if (!item.disabled) item.run(closeMenu);
              }}
            >
              <span className="menu-label">{item.label}</span>
              {item.description === undefined ? null : (
                <span id={descriptionId} className="menu-hint">
                  {item.description}
                </span>
              )}
            </button>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
