import { useEffect, useId, useRef, useState } from 'react';
import { SAVED_COPY } from './saved-copy.js';

export interface MenuItem {
  readonly key: string;
  readonly label: string;
  readonly onChoose: () => void;
  /** Shown in the warning colour, after a rule. */
  readonly danger?: boolean;
  /** Said beside the label, and the item does nothing: what the person may not do to a pattern that is not theirs. */
  readonly inert?: string;
}

/** A line of the menu that is not an item: it says why the items after it do nothing. */
export interface MenuNote {
  readonly key: string;
  readonly note: string;
}

export type MenuEntry = MenuItem | MenuNote;

interface Props {
  /** The pattern the menu is for, so that its name tells which row it belongs to. */
  readonly name: string;
  readonly items: readonly MenuEntry[];
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
    menu?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    const away = (event: MouseEvent): void => {
      if (event.target instanceof Node && !menu?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false);
    };
    // a native listener: the panel listens for Escape on its frame, above the menu, and this one must be reached first
    const onKeyDown = (event: KeyboardEvent): void => {
      // an item that does nothing stays in the order of the arrow keys, so that it is heard with what it says
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

  if (items.filter((entry) => 'label' in entry).length === 0) return null;

  return (
    <span className="pattern-row-menu">
      <button ref={trigger} type="button" className="secondary" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={`${SAVED_COPY.menu}: ${name}`} onClick={() => setOpen((now) => !now)}>
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <div id={id} ref={list} role="menu" aria-label={name} className="pattern-menu">
          {entriesOf(items).map((entry) =>
            entry.kind === 'item' ? (
              <MenuButton key={entry.item.key} item={entry.item} trigger={trigger} close={() => setOpen(false)} />
            ) : entry.kind === 'rule' ? (
              <div key={entry.key} role="separator" className="pattern-menu-rule" />
            ) : (
              <div key={entry.note.key} role="group" aria-labelledby={`${id}-${entry.note.key}`}>
                <p id={`${id}-${entry.note.key}`} className="pattern-menu-note">
                  {entry.note.note}
                </p>
                {entry.items.map((item) => (
                  <MenuButton key={item.key} item={item} trigger={trigger} close={() => setOpen(false)} />
                ))}
              </div>
            ),
          )}
        </div>
      ) : null}
    </span>
  );
}

type Shown =
  | { readonly kind: 'item'; readonly item: MenuItem }
  | { readonly kind: 'rule'; readonly key: string }
  | { readonly kind: 'group'; readonly note: MenuNote; readonly items: readonly MenuItem[] };

/** The entries as the menu draws them: a rule before an item in the warning colour, and a note with the items after it as one labelled group. */
function entriesOf(entries: readonly MenuEntry[]): Shown[] {
  const shown: Shown[] = [];
  for (const entry of entries) {
    if ('note' in entry) {
      shown.push({ kind: 'group', note: entry, items: [] });
      continue;
    }
    const last = shown.at(-1);
    if (last?.kind === 'group') {
      shown[shown.length - 1] = { ...last, items: [...last.items, entry] };
      continue;
    }
    if (entry.danger === true) shown.push({ kind: 'rule', key: `${entry.key}-rule` });
    shown.push({ kind: 'item', item: entry });
  }
  return shown;
}

function MenuButton({ item, trigger, close }: { readonly item: MenuItem; readonly trigger: React.RefObject<HTMLButtonElement | null>; readonly close: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={item.inert === undefined ? undefined : true}
      aria-label={item.inert === undefined ? undefined : `${item.label}, ${item.inert}`}
      className={`pattern-menu-item${item.danger === true ? ' pattern-menu-danger' : ''}${item.inert === undefined ? '' : ' pattern-menu-inert'}`}
      onClick={() => {
        if (item.inert !== undefined) return;
        // the focused item goes with the menu: the button takes the focus first, so that a dialog gives it back to the button
        trigger.current?.focus();
        close();
        item.onChoose();
      }}
    >
      {item.label}
      {item.inert === undefined ? null : <span className="pattern-menu-tag">{item.inert}</span>}
    </button>
  );
}
