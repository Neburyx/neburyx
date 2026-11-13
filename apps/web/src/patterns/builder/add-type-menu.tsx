import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { LINK_COPY, leavingText } from './copy.js';
import type { Direction, TypeOption } from './model.js';

interface Props {
  readonly from: string;
  readonly direction: Direction;
  readonly options: readonly TypeOption[];
  readonly chosen: readonly string[];
  readonly full: boolean;
  readonly nameOf: (type: string | undefined) => string;
  readonly onToggle: (option: TypeOption) => void;
}

/**
 * The menu that adds relationship types to a step (frame PB3): the types that leave the step's start in its direction, each with the type it leads to and whether the mapping gives it a date, the chosen ones ticked.
 * It stays open while types are ticked; the arrow keys move between them, Space or Enter ticks, Escape closes it and gives the focus back to the button.
 */
export function AddTypeMenu({ from, direction, options, chosen, full, nameOf, onToggle }: Props) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus();
    const away = (event: PointerEvent): void => {
      if (event.target instanceof Node && (menu.current?.contains(event.target) || button.current?.contains(event.target))) return;
      setOpen(false);
    };
    // the panel's frame closes the panel on Escape with a listener of its own, which runs before React's: the menu takes the key first
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    const node = menu.current;
    node?.addEventListener('keydown', escape);
    document.addEventListener('pointerdown', away);
    return () => {
      node?.removeEventListener('keydown', escape);
      document.removeEventListener('pointerdown', away);
    };
  }, [open]);
  const items = (): HTMLElement[] => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? [])];
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : undefined;
    if (move === undefined) return;
    event.preventDefault();
    all[(move + all.length) % all.length]?.focus();
  };
  return (
    <div className="pattern-add-type">
      <button ref={button} type="button" className="secondary pattern-add-type-button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((was) => !was)}>
        {LINK_COPY.addType}
      </button>
      {open ? (
        <div id={id} ref={menu} role="menu" aria-label={leavingText(nameOf(from), direction)} className="pattern-type-menu" onKeyDown={onKeyDown}>
          <p className="pattern-type-menu-heading">{leavingText(nameOf(from), direction)}</p>
          {options.map((option) => {
            const ticked = chosen.includes(option.type);
            const blocked = !ticked && full;
            return (
              <div
                key={`${option.type}-${option.arrival}`}
                role="menuitemcheckbox"
                aria-checked={ticked}
                aria-disabled={blocked ? true : undefined}
                tabIndex={-1}
                className="pattern-type-menu-item"
                onClick={() => !blocked && onToggle(option)}
                onKeyDown={(event) => {
                  if ((event.key === ' ' || event.key === 'Enter') && !blocked) {
                    event.preventDefault();
                    onToggle(option);
                  }
                }}
              >
                <span aria-hidden="true" className="pattern-type-menu-tick">
                  {ticked ? '✓' : ''}
                </span>
                <span className="pattern-type-menu-type">{option.type}</span>
                <span className="pattern-type-menu-lead">{`→ ${nameOf(option.arrival)} · ${option.dated ? LINK_COPY.hasDate : LINK_COPY.noDate}`}</span>
              </div>
            );
          })}
          {full ? <p className="pattern-type-menu-note">{LINK_COPY.typesAtMost}</p> : null}
          <p className="pattern-type-menu-note">{LINK_COPY.onlyMapped}</p>
        </div>
      ) : null}
    </div>
  );
}
