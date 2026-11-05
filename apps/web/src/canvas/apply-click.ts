import type { ClientState } from '../state/client-state.js';
import { StateError } from '../state/errors.js';
import { drawnKeys } from '../state/loaded-graph.js';
import type { RightClick } from './scene.js';
import { selectionAfterClick, type Click } from './selection-gestures.js';

/** The selection a click on an item (or the keyboard's stand-in for one) leads to, by the matrix of the pointer modes. */
export function applyClick(state: ClientState, click: Click): void {
  const { tool, selection } = state.presentation.view.getState();
  replaceSelection(state, selectionAfterClick(tool, selection, click));
}

export function replaceSelection(state: ClientState, next: readonly string[] | undefined): void {
  if (next === undefined) return;
  try {
    state.presentation.select(next);
  } catch (error) {
    // a click can arrive for an item the investigation no longer holds; that is stale and changes nothing
    if (!(error instanceof StateError) || error.code !== 'UNKNOWN_ELEMENT') throw error;
  }
}

/** A right-click on an item that is not selected selects it first, on a selected item keeps the selection, on empty canvas leaves it; a click on something that is not drawn opens nothing. */
export function openContextMenu(state: ClientState, request: RightClick): void {
  const { target, x, y } = request;
  if (target === undefined) {
    state.presentation.setOpenMenu({ kind: 'canvas', key: undefined, x, y });
    return;
  }
  if (!drawnKeys(state.loadedGraph()).has(target.key)) return;
  if (!state.presentation.view.getState().selection.has(target.key)) state.presentation.select([target.key]);
  state.presentation.setOpenMenu({ kind: target.kind, key: target.key, x, y });
}
