// Scenarios more than one file of the suite starts from.
import { expect } from 'vitest';
import { AUTOSAVE_DELAY_MS, ref, SOURCE, type Running, type StoredEdgeRef, type Tab } from './rig.js';

export const LINKED = (stableId: string): StoredEdgeRef => ({ sourceId: SOURCE, type: 'LINKED', from: 'hub', to: 'leaf', stableId });
export const HAS = (stableId: string): StoredEdgeRef => ({ sourceId: SOURCE, type: 'HAS', from: 'hub', to: 'part', stableId });
/** Opens the investigation in a fresh tab and tells it which types the mapping names, as the workspace does once the profile has loaded: the stored type filter is applied then. */
export async function reopen(running: Running, id: string): Promise<Tab> {
  const tab = running.tab();
  expect(await tab.openById(id)).toMatchObject({ kind: 'shown', id });
  tab.mapTypes(['hub', 'leaf', 'part'], ['LINKED', 'HAS']);
  return tab;
}
/** An investigation in which the person has loaded, moved, pinned, hidden, filtered and laid out, written to the store by autosave. */
export async function arranged(running: Running): Promise<{ readonly tab: Tab; readonly id: string }> {
  const tab = running.tab();
  await tab.open(ref('hub', 'H-1'));
  const id = tab.state.investigation.getState().id ?? '';
  tab.mapTypes(['hub', 'leaf', 'part'], ['LINKED', 'HAS']);
  await tab.load([ref('leaf', 'L-1'), ref('leaf', 'L-2'), ref('leaf', 'L-3'), ref('leaf', 'L-4'), ref('part', 'P-1')], [LINKED('r-L1'), LINKED('r-L2'), HAS('r-P1')]);
  const at = (entityType: string, stableId: string) => tab.nodeKey(entityType, stableId);
  tab.state.presentation.setPositions(
    new Map([
      [at('hub', 'H-1'), { x: 0, y: 0 }],
      [at('leaf', 'L-1'), { x: 120, y: -40 }],
      [at('leaf', 'L-2'), { x: -75.5, y: 310 }],
      [at('leaf', 'L-3'), { x: 5, y: 5 }],
      [at('leaf', 'L-4'), { x: 0.25, y: -0.75 }],
      [at('part', 'P-1'), { x: 900, y: 900 }],
    ]),
  );
  tab.state.presentation.pin([at('leaf', 'L-1'), at('hub', 'H-1')]);
  tab.state.hide([at('leaf', 'L-3')]);
  tab.state.presentation.setLayout('radial');
  tab.state.setEntityTypeOff('part', true);
  tab.state.setRelationshipTypeOff('HAS', true);
  // the first viewport the drawing makes of a new investigation is the drawing's own; the second is the person's
  tab.state.presentation.setViewport({ zoom: 1, x: 0, y: 0 });
  tab.state.presentation.setViewport({ zoom: 1.5, x: 10, y: -5 });
  await running.advance(AUTOSAVE_DELAY_MS);
  await tab.written();
  return { tab, id };
}

/** Identifiers a database or a path cannot hold as they are: a NUL, a lone surrogate, the prefix of the stored form, only dots, a separator, characters a path reads, and a long one. */
export const ODD_IDS: readonly string[] = ['has\u0000nul', 'lone\ud800surrogate', '~e1:looks-encoded', '..', '.', 'a/b', 'a b%20c?d#e', 'x'.repeat(199)];
