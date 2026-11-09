import type { ComponentType } from 'react';
import type { ClientState } from '../state/client-state.js';
import { drawnKeys } from '../state/loaded-graph.js';
import type { PanelRegistry } from '../workspace/panel-registry.js';
import { CompareDock } from './compare-panel.js';
import type { Compare } from './compare.js';
import { COMPARE_PANEL_TITLE } from './copy.js';
import { COMPARE_DEFAULT_WIDTH, COMPARE_MAX_WIDTH } from './limits.js';

export const COMPARE_PANEL_ID = 'compare';

const epochOf = (state: ClientState): string => JSON.stringify([state.investigation.getState().id, state.mask.getState()]);

/**
 * Keeps the comparison in the dock exactly while a target is set, takes the column of an element that leaves the drawn graph out, and closes it on a change of investigation or masking.
 * It lives outside React, so leaving the page keeps nothing behind.
 */
export function bindComparePanel(state: ClientState, panels: PanelRegistry, compare: Compare): () => void {
  let remove: (() => void) | undefined;
  let epoch = epochOf(state);
  const Content: ComponentType = () => <CompareDock compare={compare} />;
  const sync = (): void => {
    const now = epochOf(state);
    if (now !== epoch) {
      epoch = now;
      compare.close();
    }
    const held = compare.target.getState();
    if (held !== undefined) {
      const drawn = drawnKeys(state.visibleGraph());
      compare.drop(held.columns.filter((column) => !drawn.has(column.key)).map((column) => column.key));
    }
    const open = compare.target.getState() !== undefined;
    if (open && remove === undefined) remove = panels.register({ id: COMPARE_PANEL_ID, title: COMPARE_PANEL_TITLE, placement: { kind: 'dock' }, initialWidth: COMPARE_DEFAULT_WIDTH, maxWidth: COMPARE_MAX_WIDTH, content: Content });
    else if (!open && remove !== undefined) {
      remove();
      remove = undefined;
    }
  };
  const unsubscribes = [state.presentation.view.subscribe(sync), state.server.subscribe(sync), state.investigation.subscribe(sync), state.mask.subscribe(sync), compare.target.subscribe(sync)];
  sync();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    remove?.();
    remove = undefined;
  };
}
