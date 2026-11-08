import type { ClientState } from '../state/client-state.js';
import type { CanvasCommands } from './canvas-commands.js';
import { FOCUS_LEFT } from '../state/presentation-state.js';
import { formatNumber } from '../workspace/scope-text.js';
import { drawnEntityKeys } from './hide-commands.js';

export const focusAnnouncement = (count: number): string => `Focus on ${formatNumber(count)} ${count === 1 ? 'entity' : 'entities'}. Leave focus from the scope line.`;

/** The one command behind the node menu and F: puts focus on a drawn entity and tells a screen reader how many entities are drawn. Does nothing for an entity that is not drawn. */
export function enterFocus(state: ClientState, key: string, canvas?: CanvasCommands): void {
  if (!drawnEntityKeys(state).has(key)) return;
  state.focusOn(key, canvas?.viewport());
  state.presentation.announceMove(focusAnnouncement(state.visibleGraph().nodes.length));
}

/** Ends focus, puts back the viewport from before it, and tells a screen reader. Does nothing when focus is off. */
export function leaveFocus(state: ClientState): void {
  if (state.presentation.view.getState().neighborhoodFocus === undefined) return;
  state.presentation.leaveFocus();
  state.presentation.announceMove(FOCUS_LEFT);
}

/** Leaves focus, then puts the keyboard focus on the canvas, since the control that was used goes with the focus. */
export function leaveFocusAndFocusCanvas(state: ClientState): void {
  leaveFocus(state);
  document.querySelector<HTMLElement>('[data-key-scope="canvas"]')?.focus();
}

/** What F does: with one entity selected that is not the focused one, puts focus on it; with focus on and nothing, or only the focused entity, selected, ends it; otherwise nothing. */
export function focusKeyAction(state: ClientState): 'enter' | 'leave' | undefined {
  const { selection, neighborhoodFocus } = state.presentation.view.getState();
  if (selection.size === 1) {
    const [only] = [...selection];
    if (only === neighborhoodFocus) return 'leave';
    return only !== undefined && drawnEntityKeys(state).has(only) ? 'enter' : undefined;
  }
  return selection.size === 0 && neighborhoodFocus !== undefined ? 'leave' : undefined;
}

export function runFocusKey(state: ClientState, canvas?: CanvasCommands): void {
  const action = focusKeyAction(state);
  if (action === 'leave') leaveFocus(state);
  else if (action === 'enter') {
    const [only] = [...state.presentation.view.getState().selection];
    if (only !== undefined) enterFocus(state, only, canvas);
  }
}
