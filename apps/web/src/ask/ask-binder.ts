import { registerAiAction } from '../ai/ai-actions.js';
import { askSending } from './ask-activity.js';
import type { ClientState } from '../state/client-state.js';
import { INSPECTOR_PANEL_TOP } from '../inspector/inspector-layout.js';
import type { PanelRegistry } from '../workspace/panel-registry.js';
import { AskPanel } from './ask-panel.js';
import { ASK_COPY } from './copy.js';

export const ASK_PANEL_ID = 'ask';
export const ASK_PANEL_WIDTH = 360;

/** Lives outside React, so leaving the page keeps the state and leaves no panel behind; a panel registered later is drawn above one registered earlier, so Ask sits above the Inspector. */
export function bindAskPanel(state: ClientState, panels: PanelRegistry): () => void {
  let remove: (() => void) | undefined;
  const sync = (): void => {
    const open = state.presentation.view.getState().askOpen;
    if (open && remove === undefined) {
      remove = panels.register({ id: ASK_PANEL_ID, title: ASK_COPY.title, placement: { kind: 'floating', side: 'right', top: INSPECTOR_PANEL_TOP }, initialWidth: ASK_PANEL_WIDTH, content: AskPanel });
    } else if (!open && remove !== undefined) {
      remove();
      remove = undefined;
    }
  };
  const unsubscribe = state.presentation.view.subscribe(sync);
  const unregister = registerAiAction('ask', () => {
    if (askSending.getState()) return;
    state.presentation.setAskOpen(!state.presentation.view.getState().askOpen);
  });
  sync();
  return () => {
    unsubscribe();
    unregister();
    remove?.();
    remove = undefined;
  };
}

