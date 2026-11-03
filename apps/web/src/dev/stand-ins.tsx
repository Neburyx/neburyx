import type { ComponentType } from 'react';
import { Link } from 'react-router';
import { EXPLORE_PATH } from '../shell/navigation.js';
import type { SlotName, SlotRegistry } from '../workspace/slots.js';
import '../styles/stand-ins.css';

export const STAND_IN_MARKER = 'neburyx-dev-stand-ins';

const STAND_INS: readonly (readonly [SlotName, ComponentType])[] = [
  ['investigation-menu', () => <button type="button" className="stand-in-header-action" aria-label="Investigation menu">···</button>],
  ['views', () => <button type="button" className="stand-in-header-action">Views ▾</button>],
  ['export', () => <button type="button" className="stand-in-header-action">Export</button>],
  ['save', () => <button type="button" className="stand-in-header-action stand-in-save">Save</button>],
  ['tool-strip', () => <div className="stand-in stand-in-tool-strip" data-dev-tool={STAND_IN_MARKER}>Tools</div>],
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
