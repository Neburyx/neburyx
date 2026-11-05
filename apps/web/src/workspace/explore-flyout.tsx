import { useEffect, useRef, type KeyboardEvent } from 'react';
import { runSelectionCommand, type SelectionCommandId } from '../canvas/selection-commands.js';
import { POINTER_TOOLS, type PointerTool } from '../state/presentation-state.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useKeyBindings } from './key-binding-registry.js';
import type { FlyoutProps } from './tool-registry.js';

interface Row {
  readonly name: string;
  readonly binding: string;
  readonly icon: string;
}

const MODE_ROWS: Readonly<Record<PointerTool, Row>> = {
  select: { name: 'Select', binding: 'tool-select', icon: 'icon-select' },
  pan: { name: 'Pan', binding: 'tool-pan', icon: 'icon-pan' },
  box: { name: 'Box select', binding: 'tool-box', icon: 'icon-box-select' },
};

const COMMAND_ROWS: readonly (Row & { readonly id: SelectionCommandId })[] = [
  { id: 'select-all', name: 'Select all', binding: 'select-all', icon: 'icon-box-select' },
  { id: 'invert-selection', name: 'Invert selection', binding: 'invert-selection', icon: 'icon-invert' },
  { id: 'clear-selection', name: 'Clear selection', binding: 'clear-selection', icon: 'icon-clear' },
];

const ITEMS = '[role="menuitemradio"], [role="menuitem"]';

function moveFocus(event: KeyboardEvent<HTMLElement>): void {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEMS)];
  const at = items.findIndex((item) => item === document.activeElement);
  const target = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
  if (target === undefined || items.length === 0) return;
  event.preventDefault();
  items[(target + items.length) % items.length]?.focus();
}

export function ExploreFlyout({ close }: FlyoutProps) {
  const state = useClientState();
  const tool = useStoreSelector(state.presentation.view, (current) => current.tool);
  const menu = useRef<HTMLDivElement>(null);
  const bindings = useKeyBindings();
  const hintOf = (id: string): string | undefined => bindings.find((candidate) => candidate.id === id)?.shown[0];
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, []);
  return (
    <div className="menu-panel" role="menu" aria-label="Explore" ref={menu} onKeyDown={moveFocus}>
      <p className="menu-heading" aria-hidden="true">Explore</p>
      {POINTER_TOOLS.map((mode) => {
        const row = MODE_ROWS[mode];
        const chosen = tool === mode;
        return (
          <button
            key={mode}
            type="button"
            role="menuitemradio"
            aria-checked={chosen}
            tabIndex={-1}
            className="menu-row"
            onClick={() => {
              state.presentation.setTool(mode);
              close();
            }}
          >
            <span className={`icon ${row.icon}`} aria-hidden="true" />
            <span className="menu-label">{row.name}</span>
            {chosen ? <span className="icon icon-check" aria-hidden="true" /> : null}
            {hintOf(row.binding) === undefined ? null : <span className="menu-hint" aria-hidden="true">{hintOf(row.binding)}</span>}
          </button>
        );
      })}
      <div className="menu-separator" role="separator" />
      {COMMAND_ROWS.map((row) => (
        <button
          key={row.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="menu-row"
          onClick={() => {
            runSelectionCommand(state, row.id);
            close();
          }}
        >
          <span className={`icon ${row.icon}`} aria-hidden="true" />
          <span className="menu-label">{row.name}</span>
          {hintOf(row.binding) === undefined ? null : <span className="menu-hint" aria-hidden="true">{hintOf(row.binding)}</span>}
        </button>
      ))}
    </div>
  );
}
