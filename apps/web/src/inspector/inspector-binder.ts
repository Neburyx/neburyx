import type { ClientState } from '../state/client-state.js';
import type { PanelRegistry } from '../workspace/panel-registry.js';
import { inspectorContent } from './inspector-panel.js';
import type { Inspector } from './inspector.js';
import { INSPECTOR_PANEL_ID, INSPECTOR_PANEL_TOP, INSPECTOR_PANEL_WIDTH } from './inspector-layout.js';
import { inspectedKey } from './inspected.js';
import { ASK_PANEL_ID, ASK_PANEL_WIDTH } from '../ask/panel-layout.js';
import { PANEL_GAP, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from '../workspace/panel-limits.js';

/** While the Ask panel is open the inspector hangs beside it, on its left, never over it: the distance from the right edge is the Ask panel's width between two gaps. Nothing opens the panel until the rebuilt Ask panel lands, so until then the inset is the gap alone. */
function insetOf(state: ClientState): number {
  const view = state.presentation.view.getState();
  // held to the limits the panel is drawn with, so a stored width below the least is not trusted
  return view.askOpen ? PANEL_GAP + Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, view.panelSizes.get(ASK_PANEL_ID) ?? ASK_PANEL_WIDTH)) + PANEL_GAP : PANEL_GAP;
}

const epochOf = (state: ClientState): string => JSON.stringify([state.investigation.getState().id, state.mask.getState()]);

/**
 * Keeps the inspector's panel registered exactly while one drawn entity is selected (or one of its drawn relationships, once it was shown) and the person has not closed its inspector. It lives outside React, so leaving the page keeps nothing behind. A change of investigation,
 * source or masking closes the inspector of the entity it showed.
 */
export function bindInspector(state: ClientState, panels: PanelRegistry, inspector: Inspector): () => void {
  let remove: (() => void) | undefined;
  let placedAt = PANEL_GAP;
  let epoch = epochOf(state);
  const Content = inspectorContent(inspector);
  const sync = (): void => {
    const shown = inspectedKey(state.presentation.view.getState().selection, state.visibleGraph(), inspector.anchor.getState());
    if (inspector.anchor.getState() !== shown) inspector.setAnchor(shown);
    const now = epochOf(state);
    if (now !== epoch) {
      epoch = now;
      if (shown !== undefined) inspector.dismiss(shown);
    }
    const dismissed = inspector.dismissed.getState();
    if (dismissed !== undefined && dismissed !== shown) inspector.clearDismissal();
    const open = shown !== undefined && inspector.dismissed.getState() !== shown;
    const inset = insetOf(state);
    const placement = { kind: 'floating' as const, side: 'right' as const, top: INSPECTOR_PANEL_TOP, ...(inset === PANEL_GAP ? {} : { inset }) };
    if (open && remove === undefined) {
      placedAt = inset;
      remove = panels.register({ id: INSPECTOR_PANEL_ID, title: 'Inspector', placement, initialWidth: INSPECTOR_PANEL_WIDTH, content: Content });
    } else if (open && inset !== placedAt) {
      // moved, not registered again, so what the inspector holds stays
      placedAt = inset;
      panels.place(INSPECTOR_PANEL_ID, placement);
    } else if (!open && remove !== undefined) {
      remove();
      remove = undefined;
    }
  };
  const unsubscribes = [state.presentation.view.subscribe(sync), state.server.subscribe(sync), state.investigation.subscribe(sync), state.mask.subscribe(sync), inspector.dismissed.subscribe(sync)];
  sync();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    remove?.();
    remove = undefined;
  };
}
