import { useMenuPlacement } from '../menu-placement.js';
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

interface Props {
  /** The text of the button that opens the menu. */
  readonly button: string;
  /** What the menu is called for a screen reader. */
  readonly label: string;
  readonly disabled?: boolean;
  readonly describedBy?: string | undefined;
  /** The menu's items, given a function that closes the menu and puts the focus back on the button. */
  readonly children: (close: () => void) => ReactNode;
  readonly className?: string;
}

const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"]';

/**
 * A button that opens a menu: the first item takes the focus, the arrow keys, Home and End move between the items, Escape closes it and gives the focus back to the button, Tab and a press outside close it.
 * The panel's frame closes the panel on Escape with a listener of its own, which runs before React's: the menu takes the key first, with a listener on the menu itself.
 */
export function PopupMenu({ button, label, disabled, describedBy, children, className }: Props) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useMenuPlacement(open, menu, opener);
  const close = (): void => {
    setOpen(false);
    opener.current?.focus();
  };
  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector<HTMLElement>(ITEMS)?.focus();
    const away = (event: PointerEvent): void => {
      if (event.target instanceof Node && (menu.current?.contains(event.target) || opener.current?.contains(event.target))) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      opener.current?.focus();
    };
    const node = menu.current;
    node?.addEventListener('keydown', escape);
    document.addEventListener('pointerdown', away);
    return () => {
      node?.removeEventListener('keydown', escape);
      document.removeEventListener('pointerdown', away);
    };
  }, [open]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const all = [...(menu.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : undefined;
    if (move === undefined || all.length === 0) return;
    event.preventDefault();
    all[(move + all.length) % all.length]?.focus();
  };
  return (
    <div className={className === undefined ? 'popup-menu' : `popup-menu ${className}`}>
      <button ref={opener} type="button" className="secondary popup-menu-button" disabled={disabled} aria-describedby={describedBy} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((was) => !was)}>
        {button}
      </button>
      {open ? (
        <div id={id} ref={menu} role="menu" aria-label={label} className="popup-menu-list" onKeyDown={onKeyDown}>
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}
