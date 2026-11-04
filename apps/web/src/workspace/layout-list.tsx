import type { KeyboardEvent } from 'react';

export const LAYOUTS = [{ id: 'force', label: 'Force' }] as const;

export type LayoutId = (typeof LAYOUTS)[number]['id'];

interface LayoutListProps {
  /** Layouts that cannot run now (nothing loaded, or no renderer) are shown and do nothing. */
  readonly disabled: boolean;
  readonly onChoose: (id: LayoutId) => void;
}

function move(event: KeyboardEvent<HTMLDivElement>): void {
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const at = rows.findIndex((row) => row === document.activeElement);
  const last = rows.length - 1;
  const next = event.key === 'ArrowDown' ? (at >= last ? 0 : at + 1) : event.key === 'ArrowUp' ? (at <= 0 ? last : at - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined;
  if (next === undefined) return;
  event.preventDefault();
  rows[next]?.focus();
}

export function LayoutList({ disabled, onChoose }: LayoutListProps) {
  return (
    <div className="layout-list" role="menu" aria-label="Layout" onKeyDown={move}>
      {LAYOUTS.map((layout) => (
        <button key={layout.id} type="button" role="menuitem" className={`menu-row${disabled ? ' menu-row-disabled' : ''}`} aria-disabled={disabled ? true : undefined} onClick={() => (disabled ? undefined : onChoose(layout.id))}>
          <span className="menu-label">{layout.label}</span>
        </button>
      ))}
    </div>
  );
}
