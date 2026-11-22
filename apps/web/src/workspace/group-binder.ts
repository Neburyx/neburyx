import type { ClientState } from '../state/client-state.js';
import { GroupPanel } from './group-panel.js';
import { GROUP_PANEL_COPY } from './group-copy.js';
import type { PanelRegistry } from './panel-registry.js';

const GROUP_PANEL_ID = 'group';
const GROUP_PANEL_TOP = 64;
const GROUP_PANEL_WIDTH = 300;
/** Clear of the tool strip: the panel sits to its right. */
const GROUP_PANEL_INSET = 72;

/** Lives outside React, so leaving the page keeps the state and leaves no panel behind. */
export function bindGroupPanel(state: ClientState, panels: PanelRegistry): () => void {
  let remove: (() => void) | undefined;
  const sync = (): void => {
    const open = state.presentation.view.getState().groupOpen;
    if (open && remove === undefined) remove = panels.register({ id: GROUP_PANEL_ID, title: GROUP_PANEL_COPY.title, placement: { kind: 'floating', side: 'left', top: GROUP_PANEL_TOP, inset: GROUP_PANEL_INSET }, initialWidth: GROUP_PANEL_WIDTH, content: GroupPanel });
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
