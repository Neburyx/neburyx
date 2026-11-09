import { INSPECTOR_PANEL_ID, INSPECTOR_PANEL_WIDTH } from '../inspector/inspector-layout.js';
import type { ClientState } from '../state/client-state.js';
import { LegendPanel } from './legend-panel.js';
import { PANEL_GAP, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from './panel-limits.js';
import type { PanelRegistry } from './panel-registry.js';

export const LEGEND_PANEL_ID = 'legend';
export const LEGEND_TOP = 64;

/** The distance from the right edge: the panel gap, and past the inspector at the width it has now while that is open. */
function insetOf(state: ClientState, panels: PanelRegistry): number | undefined {
  if (!panels.view.getState().some((panel) => panel.id === INSPECTOR_PANEL_ID)) return undefined;
  const width = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, state.presentation.view.getState().panelSizes.get(INSPECTOR_PANEL_ID) ?? INSPECTOR_PANEL_WIDTH));
  return PANEL_GAP + width + PANEL_GAP;
}

/** Keeps the legend's panel registered exactly while the legend is open, and moved (not registered again) past the inspector while that is open. It lives outside React, so leaving the page does not lose the state or leave a panel behind; the function it returns stops it and takes the panel out. */
export function bindLegend(state: ClientState, panels: PanelRegistry): () => void {
  let remove: (() => void) | undefined;
  let placedAt: number | undefined;
  let syncing = false;
  const sync = (): void => {
    // registering or moving the panel changes the panels, which calls this again before `remove` is set
    if (syncing) return;
    syncing = true;
    try {
      run();
    } finally {
      syncing = false;
    }
  };
  const run = (): void => {
    const open = state.presentation.view.getState().legendOpen;
    const inset = insetOf(state, panels);
    if (open && remove === undefined) {
      remove = panels.register({ id: LEGEND_PANEL_ID, title: 'Legend', placement: { kind: 'floating', side: 'right', top: LEGEND_TOP, ...(inset === undefined ? {} : { inset }) }, content: LegendPanel });
      placedAt = inset;
    } else if (!open && remove !== undefined) {
      remove();
      remove = undefined;
      placedAt = undefined;
    } else if (remove !== undefined && placedAt !== inset) {
      panels.place(LEGEND_PANEL_ID, { kind: 'floating', side: 'right', top: LEGEND_TOP, ...(inset === undefined ? {} : { inset }) });
      placedAt = inset;
    }
  };
  const unsubscribes = [state.presentation.view.subscribe(sync), panels.view.subscribe(sync)];
  sync();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    remove?.();
    remove = undefined;
  };
}
