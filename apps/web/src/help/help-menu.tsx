import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useClientState } from '../state/context.js';
import { useKeyBindings } from '../workspace/key-binding-registry.js';
import type { HelpItem } from './help-items.js';

export const HELP_BUTTON_LABEL = 'Help';
export const EXTERNAL_MARK = '↗';

interface Place {
  readonly left: number;
  readonly bottom: number;
}

export function HelpMenu({ items }: { readonly items: readonly HelpItem[] }) {
  const state = useClientState();
  const bindings = useKeyBindings();
  const [place, setPlace] = useState<Place | undefined>();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const open = place !== undefined;

  const close = (): void => setPlace(undefined);
  const toggle = (): void => {
    const rect = button.current?.getBoundingClientRect();
    setPlace(open || rect === undefined ? undefined : { left: rect.left, bottom: window.innerHeight - rect.top });
  };

  useEffect(() => {
    if (!open) return undefined;
    panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && (panel.current?.contains(event.target) === true || button.current?.contains(event.target) === true)) return;
      setPlace(undefined);
    };
    const onResize = (): void => setPlace(undefined);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      button.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      close();
      button.current?.focus();
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
    <div className="help-menu">
      <button ref={button} type="button" className="help-button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={toggle}>
        <span className="icon icon-help" aria-hidden="true" />
        {HELP_BUTTON_LABEL}
      </button>
      {open ? (
        <div ref={panel} id={menuId} className="menu-panel help-menu-panel" role="menu" aria-label={HELP_BUTTON_LABEL} onKeyDown={onKeyDown} style={{ left: place.left, bottom: place.bottom }}>
          {items.map((item) => (
            <Fragment key={item.id}>
              {item.dividerBefore === true ? <div role="separator" className="menu-separator" /> : null}
              {item.kind === 'link' ? (
                <a role="menuitem" className="menu-row" href={item.href} target="_blank" rel="noopener noreferrer" onClick={close}>
                  <span className="menu-label">{item.label}</span>
                  <span className="menu-hint" aria-hidden="true">
                    {EXTERNAL_MARK}
                  </span>
                </a>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-row"
                  onClick={() => {
                    close();
                    button.current?.focus();
                    item.run(state);
                  }}
                >
                  <span className="menu-label">{item.label}</span>
                  <span className="menu-hint">{bindings.find((binding) => binding.id === item.bindingId)?.shown.join(' ')}</span>
                </button>
              )}
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
