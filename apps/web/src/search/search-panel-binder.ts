import type { ClientState } from '../state/client-state.js';
import type { PanelRegistry } from '../workspace/panel-registry.js';
import { SearchPanel } from './search-panel.js';

export const SEARCH_PANEL_ID = 'search';
export const SEARCH_PANEL_TOP = 64;
export const SEARCH_PANEL_WIDTH = 300;
/** Clear of the tool strip: the panel sits to its right. */
export const SEARCH_PANEL_INSET = 72;

/** Lives outside React, so leaving the page keeps the state and leaves no panel behind. */
export function bindSearchPanel(state: ClientState, panels: PanelRegistry): () => void {
  let remove: (() => void) | undefined;
  const sync = (): void => {
    const open = state.presentation.view.getState().searchOpen;
    if (open && remove === undefined) remove = panels.register({ id: SEARCH_PANEL_ID, title: 'Search', placement: { kind: 'floating', side: 'left', top: SEARCH_PANEL_TOP, inset: SEARCH_PANEL_INSET }, initialWidth: SEARCH_PANEL_WIDTH, content: SearchPanel });
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
