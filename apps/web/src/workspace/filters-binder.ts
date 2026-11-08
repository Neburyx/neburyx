import type { ClientState } from '../state/client-state.js';
import { FiltersPanel } from './filters-panel.js';
import type { PanelRegistry } from './panel-registry.js';

export const FILTERS_PANEL_ID = 'filters';
export const FILTERS_PANEL_TOP = 64;
export const FILTERS_PANEL_WIDTH = 300;
/** Clear of the tool strip: the panel sits to its right. */
export const FILTERS_PANEL_INSET = 72;

/** Lives outside React, so leaving the page keeps the state and leaves no panel behind. */
export function bindFiltersPanel(state: ClientState, panels: PanelRegistry): () => void {
  let remove: (() => void) | undefined;
  const sync = (): void => {
    const open = state.presentation.view.getState().filtersOpen;
    if (open && remove === undefined) remove = panels.register({ id: FILTERS_PANEL_ID, title: 'Filters', placement: { kind: 'floating', side: 'left', top: FILTERS_PANEL_TOP, inset: FILTERS_PANEL_INSET }, initialWidth: FILTERS_PANEL_WIDTH, content: FiltersPanel });
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
