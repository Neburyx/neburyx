import { createElement } from 'react';
import type { Evidence } from '../evidence/evidence.js';
import { EvidenceHandleContext } from '../patterns/evidence-handle.js';
import type { ClientState } from '../state/client-state.js';
import { FILTERS_PANEL_INSET, FILTERS_PANEL_TOP } from '../workspace/filters-binder.js';
import type { PanelRegistry } from '../workspace/panel-registry.js';
import { PATHS_COPY } from './copy.js';
import { disposeHeldPathsRun } from './use-paths-run.js';
import { PathsPanel } from './paths-panel.js';

const PATHS_PANEL_ID = 'paths';
const PATHS_PANEL_WIDTH = 320;

/** Lives outside React, so leaving the page keeps the state and leaves no panel behind. */
export function bindPathsPanel(state: ClientState, panels: PanelRegistry, evidence?: Evidence): () => void {
  const content = evidence === undefined ? PathsPanel : () => createElement(EvidenceHandleContext.Provider, { value: evidence }, createElement(PathsPanel));
  let remove: (() => void) | undefined;
  const sync = (): void => {
    const open = state.presentation.view.getState().pathsOpen;
    if (open && remove === undefined) remove = panels.register({ id: PATHS_PANEL_ID, title: PATHS_COPY.title, placement: { kind: 'floating', side: 'left', top: FILTERS_PANEL_TOP, inset: FILTERS_PANEL_INSET }, initialWidth: PATHS_PANEL_WIDTH, content });
    else if (!open && remove !== undefined) {
      remove();
      remove = undefined;
    }
  };
  const contextOf = (): string => {
    const { id, sourceId } = state.investigation.getState();
    return `${id ?? ''}\u0000${sourceId ?? ''}\u0000${state.mask.getState()}`;
  };
  let context = contextOf();
  const dropWhenContextChanges = (): void => {
    const now = contextOf();
    if (now === context) return;
    context = now;
    disposeHeldPathsRun();
  };
  const unsubscribe = state.presentation.view.subscribe(sync);
  const stopInvestigation = state.investigation.subscribe(dropWhenContextChanges);
  const stopMask = state.mask.subscribe(dropWhenContextChanges);
  sync();
  return () => {
    unsubscribe();
    stopInvestigation();
    stopMask();
    remove?.();
    remove = undefined;
  };
}
