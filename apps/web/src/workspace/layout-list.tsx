import type { KeyboardEvent } from 'react';
import { PHYSICS_MAX_ENTITIES } from '../canvas/layout-constants.js';
import { useClientState, useVisibleGraph } from '../state/context.js';
import { LAYOUT_DIRECTIONS, LAYOUTS, type LayoutDirection, type LayoutId } from '../state/layout-choice.js';
import { useStoreSelector } from '../state/store.js';

export { LAYOUTS, type LayoutId } from '../state/layout-choice.js';

export const PHYSICS_FORCE_ONLY = 'Physics works with Force';
export const physicsAboveCap = (): string => `Physics is off above ${PHYSICS_MAX_ENTITIES} entities`;

interface LayoutListProps {
  /** Layouts that cannot run now (nothing loaded, or no renderer) are shown and do nothing. */
  readonly disabled: boolean;
  /** Runs the layout the presentation state holds; called after the person chose or re-chose a layout or a direction. */
  readonly run: () => void;
  /** Called after any choice, so the list that holds the rows can close. */
  readonly done: () => void;
}

function move(event: KeyboardEvent<HTMLDivElement>): void {
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  const at = rows.findIndex((row) => row === document.activeElement);
  const last = rows.length - 1;
  const next = event.key === 'ArrowDown' ? (at >= last ? 0 : at + 1) : event.key === 'ArrowUp' ? (at <= 0 ? last : at - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined;
  if (next === undefined) return;
  event.preventDefault();
  rows[next]?.focus();
}

const rowClass = (disabled: boolean): string => `menu-row${disabled ? ' menu-row-disabled' : ''}`;

export function LayoutList({ disabled, run, done }: LayoutListProps) {
  const state = useClientState();
  const layout = useStoreSelector(state.presentation.view, (current) => current.layout);
  const direction = useStoreSelector(state.presentation.view, (current) => current.layoutDirection);
  const physics = useStoreSelector(state.presentation.view, (current) => current.physics);
  const choose = (id: LayoutId): void => {
    if (disabled) return;
    state.presentation.setLayout(id);
    run();
    done();
  };
  const turn = (id: LayoutDirection): void => {
    if (disabled) return;
    state.presentation.setLayoutDirection(id);
    run();
    done();
  };
  const shown = useVisibleGraph().nodes.length;
  const forceOnly = layout !== 'force';
  const tooMany = !forceOnly && shown > PHYSICS_MAX_ENTITIES;
  const unavailable = forceOnly || tooMany;
  return (
    <div className="layout-list" role="menu" aria-label="Layout" onKeyDown={move}>
      {LAYOUTS.map((entry) => (
        <button key={entry.id} type="button" role="menuitemradio" aria-checked={layout === entry.id} className={rowClass(disabled)} aria-disabled={disabled ? true : undefined} onClick={() => choose(entry.id)}>
          <span className="menu-label">{entry.label}</span>
        </button>
      ))}
      {layout === 'hierarchical' ? (
        <>
          <div className="menu-separator" role="separator" />
          {LAYOUT_DIRECTIONS.map((entry) => (
            <button key={entry.id} type="button" role="menuitemradio" aria-checked={direction === entry.id} className={rowClass(disabled)} aria-disabled={disabled ? true : undefined} onClick={() => turn(entry.id)}>
              <span className="menu-label">{entry.label}</span>
            </button>
          ))}
        </>
      ) : null}
      <div className="menu-separator" role="separator" />
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={physics && !forceOnly}
        className={rowClass(disabled || unavailable)}
        aria-disabled={disabled || unavailable ? true : undefined}
        onClick={() => {
          if (disabled || unavailable) return;
          state.presentation.setPhysics(!physics);
          done();
        }}
      >
        <span className="menu-label">Physics</span>
        {forceOnly ? <span className="menu-hint">{PHYSICS_FORCE_ONLY}</span> : tooMany ? <span className="menu-hint">{physicsAboveCap()}</span> : null}
      </button>
    </div>
  );
}
