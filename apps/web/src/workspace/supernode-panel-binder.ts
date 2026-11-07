import type { ClientState } from '../state/client-state.js';
import { SEARCH_PANEL_ID, SEARCH_PANEL_INSET, SEARCH_PANEL_WIDTH } from '../search/search-panel-binder.js';
import { SupernodePanel } from './supernode-panel.js';
import { PANEL_GAP, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from './panel-limits.js';
import type { PanelRegistry } from './panel-registry.js';

export const SUPERNODE_PANEL_ID = 'supernode';
export const SUPERNODE_PANEL_TOP = 64;
export const SUPERNODE_PANEL_WIDTH = 360;

const epochOf = (state: ClientState): string => JSON.stringify([state.investigation.getState().id, state.mask.getState()]);

/** The distance from the left of the canvas: beside the tool strip, and past the Search panel at the width it has now while that is open. */
function insetOf(state: ClientState): number {
  const { searchOpen, panelSizes } = state.presentation.view.getState();
  if (!searchOpen) return SEARCH_PANEL_INSET;
  const width = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, panelSizes.get(SEARCH_PANEL_ID) ?? SEARCH_PANEL_WIDTH));
  return SEARCH_PANEL_INSET + width + PANEL_GAP;
}

/**
 * Keeps the Expand relationships panel registered exactly while it is open for a node. It lives outside React, so leaving the page keeps nothing behind. The panel is about one node of one investigation under
 * one masking setting: it closes when either changes, and (through the presentation state's pruning) when the node leaves the loaded graph. It hangs from the left beside the tool strip, so the legend on the right stays
 * in reach, and is moved (not registered again) past the Search panel while that is open.
 */
export function bindSupernodePanel(state: ClientState, panels: PanelRegistry): () => void {
  let remove: (() => void) | undefined;
  let openedIn: string | undefined;
  let placedAt: number | undefined;
  const sync = (): void => {
    const { supernodePanel } = state.presentation.view.getState();
    if (supernodePanel !== undefined && remove !== undefined && openedIn !== epochOf(state)) {
      state.presentation.setSupernodePanel(undefined);
      return;
    }
    if (supernodePanel === undefined) {
      remove?.();
      remove = undefined;
      openedIn = undefined;
      placedAt = undefined;
      return;
    }
    const inset = insetOf(state);
    if (remove === undefined) {
      remove = panels.register({ id: SUPERNODE_PANEL_ID, title: 'Expand relationships', placement: { kind: 'floating', side: 'left', top: SUPERNODE_PANEL_TOP, inset }, initialWidth: SUPERNODE_PANEL_WIDTH, content: SupernodePanel });
      openedIn = epochOf(state);
      placedAt = inset;
    } else if (placedAt !== inset) {
      panels.place(SUPERNODE_PANEL_ID, { kind: 'floating', side: 'left', top: SUPERNODE_PANEL_TOP, inset });
      placedAt = inset;
    }
  };
  const unsubscribes = [state.presentation.view.subscribe(sync), state.investigation.subscribe(sync), state.mask.subscribe(sync)];
  sync();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    remove?.();
    remove = undefined;
  };
}
