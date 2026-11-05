import type { ClientState } from '../state/client-state.js';
import { LegendPanel } from './legend-panel.js';
import type { PanelRegistry } from './panel-registry.js';

export const LEGEND_PANEL_ID = 'legend';
export const LEGEND_TOP = 64;

/** Keeps the legend's panel registered exactly while the legend is open. It lives outside React, so leaving the page does not lose the state or leave a panel behind; the function it returns stops it and takes the panel out. */
export function bindLegend(state: ClientState, panels: PanelRegistry): () => void {
  let remove: (() => void) | undefined;
  const sync = (): void => {
    const open = state.presentation.view.getState().legendOpen;
    if (open && remove === undefined) remove = panels.register({ id: LEGEND_PANEL_ID, title: 'Legend', placement: { kind: 'floating', side: 'right', top: LEGEND_TOP }, content: LegendPanel });
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
