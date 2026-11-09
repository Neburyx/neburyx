import type { ClientState } from '../state/client-state.js';
import type { PanelRegistry } from '../workspace/panel-registry.js';
import { inspectorContent } from './inspector-panel.js';
import type { Inspector } from './inspector.js';
import { INSPECTOR_PANEL_ID, INSPECTOR_PANEL_TOP, INSPECTOR_PANEL_WIDTH } from './inspector-layout.js';
import { inspectedKey } from './inspected.js';

const epochOf = (state: ClientState): string => JSON.stringify([state.investigation.getState().id, state.mask.getState()]);

/**
 * Keeps the inspector's panel registered exactly while one drawn entity is selected and the person has not closed its inspector. It lives outside React, so leaving the page keeps nothing behind. A change of investigation,
 * source or masking closes the inspector of the entity it showed.
 */
export function bindInspector(state: ClientState, panels: PanelRegistry, inspector: Inspector): () => void {
  let remove: (() => void) | undefined;
  let epoch = epochOf(state);
  const Content = inspectorContent(inspector);
  const sync = (): void => {
    const shown = inspectedKey(state.presentation.view.getState().selection, state.visibleGraph());
    const now = epochOf(state);
    if (now !== epoch) {
      epoch = now;
      if (shown !== undefined) inspector.dismiss(shown);
    }
    const dismissed = inspector.dismissed.getState();
    if (dismissed !== undefined && dismissed !== shown) inspector.clearDismissal();
    const open = shown !== undefined && inspector.dismissed.getState() !== shown;
    if (open && remove === undefined) remove = panels.register({ id: INSPECTOR_PANEL_ID, title: 'Inspector', placement: { kind: 'floating', side: 'right', top: INSPECTOR_PANEL_TOP }, initialWidth: INSPECTOR_PANEL_WIDTH, content: Content });
    else if (!open && remove !== undefined) {
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
