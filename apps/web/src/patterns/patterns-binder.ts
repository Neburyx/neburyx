import type { ClientState } from '../state/client-state.js';
import type { PanelRegistry } from '../workspace/panel-registry.js';
import { FILTERS_PANEL_INSET, FILTERS_PANEL_TOP } from '../workspace/filters-binder.js';
import { PatternsPanel } from './patterns-panel.js';
import { PATTERNS_COPY } from './copy.js';

export const PATTERNS_PANEL_ID = 'patterns';
export const PATTERNS_PANEL_WIDTH = 336;

/** Lives outside React, so leaving the page keeps the state and leaves no panel behind. */
export function bindPatternsPanel(state: ClientState, panels: PanelRegistry): () => void {
  let remove: (() => void) | undefined;
  const sync = (): void => {
    const open = state.presentation.view.getState().patternsOpen;
    if (open && remove === undefined) remove = panels.register({ id: PATTERNS_PANEL_ID, title: PATTERNS_COPY.title, placement: { kind: 'floating', side: 'left', top: FILTERS_PANEL_TOP, inset: FILTERS_PANEL_INSET }, initialWidth: PATTERNS_PANEL_WIDTH, content: PatternsPanel });
    else if (!open && remove !== undefined) {
      remove();
      remove = undefined;
    }
  };
  const unsubscribe = state.presentation.view.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    remove?.();
    remove = undefined;
  };
}
