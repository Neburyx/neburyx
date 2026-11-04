import type { ComponentType } from 'react';
import { POINTER_TOOLS, type PointerTool } from '../state/presentation-state.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { Link } from 'react-router';
import { EXPLORE_PATH } from '../shell/navigation.js';
import type { SelectionAction, SelectionActionRegistry } from '../workspace/selection-actions.js';
import type { SlotName, SlotRegistry } from '../workspace/slots.js';
import '../styles/stand-ins.css';

export const STAND_IN_MARKER = 'neburyx-dev-stand-ins';

const MODE_LABELS: Readonly<Record<PointerTool, { readonly name: string; readonly key: string }>> = {
  select: { name: 'Select', key: 'V' },
  pan: { name: 'Pan', key: 'H' },
  box: { name: 'Box select', key: 'B' },
};

/** Buttons that choose the pointer mode, so the modes can be tried in a development build before a tool strip exists. */
function PointerModes() {
  const state = useClientState();
  const tool = useStoreSelector(state.presentation.view, (current) => current.tool);
  return (
    <div className="stand-in stand-in-tool-strip" data-dev-tool={STAND_IN_MARKER} role="group" aria-label="Pointer mode">
      {POINTER_TOOLS.map((mode) => (
        <button key={mode} type="button" className="stand-in-mode" aria-label={MODE_LABELS[mode].name} aria-pressed={tool === mode} onClick={() => state.presentation.setTool(mode)}>
          {MODE_LABELS[mode].key}
        </button>
      ))}
    </div>
  );
}

const STAND_INS: readonly (readonly [SlotName, ComponentType])[] = [
  ['investigation-menu', () => <button type="button" className="stand-in-header-action" aria-label="Investigation menu">···</button>],
  ['views', () => <button type="button" className="stand-in-header-action">Views ▾</button>],
  ['export', () => <button type="button" className="stand-in-header-action">Export</button>],
  ['save', () => <button type="button" className="stand-in-header-action stand-in-save">Save</button>],
  ['tool-strip', PointerModes],
  [
    'toggles',
    () => (
      <>
        <div className="stand-in stand-in-table" data-dev-tool={STAND_IN_MARKER}>Table</div>
        <div className="stand-in stand-in-legend" data-dev-tool={STAND_IN_MARKER}>Legend</div>
      </>
    ),
  ],
  ['zoom-controls', () => <div className="stand-in stand-in-zoom" data-dev-tool={STAND_IN_MARKER}>Zoom</div>],
  ['dock', () => <div className="stand-in stand-in-dock" data-dev-tool={STAND_IN_MARKER}>Dock</div>],
  ['floating', () => null],
  [
    'search',
    () => (
      <Link to={EXPLORE_PATH} className="rail-stand-in" aria-label="Search">
        <span className="icon icon-search" aria-hidden="true" />
      </Link>
    ),
  ],
  [
    'settings',
    () => (
      <button type="button" className="rail-stand-in rail-stand-in-gear" aria-label="Settings">
        <span className="icon icon-settings" aria-hidden="true" />
      </button>
    ),
  ],
];

/** Puts a stand-in in every slot that is free, leaves occupied slots as they are, and returns the function that takes out what it put in. */
export function registerStandIns(registry: SlotRegistry): () => void {
  const removals = STAND_INS.filter(([slot]) => !registry.view.getState().has(slot)).map(([slot, occupant]) => registry.register(slot, occupant));
  return () => {
    for (const remove of removals) remove();
  };
}

const icon = (name: string) => <span className={`icon icon-stand-in-${name}`} aria-hidden="true" />;

const STAND_IN_ACTIONS: readonly SelectionAction[] = [
  { id: 'stand-in-expand', label: 'Expand', icon: icon('expand'), run: () => undefined },
  { id: 'stand-in-paths', label: 'Paths between', icon: icon('paths'), run: () => undefined },
  { id: 'stand-in-group', label: 'Group', icon: icon('group'), run: () => undefined },
  { id: 'stand-in-pin', label: 'Pin', icon: icon('pin'), run: () => undefined },
  { id: 'stand-in-hide', label: 'Hide', icon: icon('hide'), run: () => undefined },
];

/** Puts a stand-in for each selection action that is not built yet, leaves the places that are taken, and returns the function that takes out what it put in. */
export function registerStandInActions(registry: SelectionActionRegistry): () => void {
  const taken = new Set(registry.view.getState().map((action) => action.id));
  const removals = STAND_IN_ACTIONS.filter((action) => !taken.has(action.id)).map((action) => registry.register(action));
  return () => {
    for (const remove of removals) remove();
  };
}
