import type { ClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { FOCUS_LEFT } from '../state/presentation-state.js';
import { formatNumber } from '../workspace/scope-text.js';

export const hiddenAnnouncement = (count: number): string => `Hid ${formatNumber(count)} ${count === 1 ? 'entity' : 'entities'}. Show them again from the scope line.`;

export const drawnEntityKeys = (state: ClientState): ReadonlySet<string> => new Set(state.visibleGraph().nodes.map((node) => elementKey(node.ref)));

/** The one command behind the menu, the Del key and the action bar: hides the drawn entities among `keys` (relationships are left alone) and tells a screen reader how many. Does nothing when there is none. */
export function hideEntities(state: ClientState, keys: readonly string[]): void {
  const drawn = drawnEntityKeys(state);
  const entities = [...new Set(keys)].filter((key) => drawn.has(key));
  if (entities.length === 0) return;
  const focusBefore = state.presentation.view.getState().neighborhoodFocus;
  state.hide(entities);
  const ended = focusBefore !== undefined && state.presentation.view.getState().neighborhoodFocus === undefined;
  state.presentation.announceMove(ended ? `${hiddenAnnouncement(entities.length)} ${FOCUS_LEFT}` : hiddenAnnouncement(entities.length));
}

/** What a menu opened on `key` hides: every selected entity when the entity is one of them, otherwise the entity alone. */
export function hideTargetsOf(selection: readonly string[], key: string | undefined): readonly string[] {
  if (key === undefined) return [];
  return selection.includes(key) ? selection : [key];
}

export function selectedEntities(state: ClientState): readonly string[] {
  const drawn = drawnEntityKeys(state);
  return [...state.presentation.view.getState().selection].filter((key) => drawn.has(key));
}

/** Shows every hidden entity again and puts the focus on the canvas, since the control that was used is gone with the count. */
export function showHiddenAndFocusCanvas(state: ClientState): void {
  state.presentation.showAllHidden();
  document.querySelector<HTMLElement>('[data-key-scope="canvas"]')?.focus();
}
