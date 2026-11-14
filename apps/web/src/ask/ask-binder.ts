import { createElement } from 'react';
import { registerAiAction } from '../ai/ai-actions.js';
import type { ClientState } from '../state/client-state.js';
import { INSPECTOR_PANEL_TOP } from '../inspector/inspector-layout.js';
import type { PanelRegistry } from '../workspace/panel-registry.js';
import { AskPanel } from './ask-panel.js';
import { AskSessionProvider, createAskSession } from './ask-session.js';
import { ASK_PANEL_ID, ASK_PANEL_WIDTH } from './panel-layout.js';
import { ASK_COPY } from './copy.js';

/** Lives outside React: the panel is registered while Ask is open, and the question and answer outlive the panel. */
export function bindAskPanel(state: ClientState, panels: PanelRegistry): () => void {
  const session = createAskSession();
  const close = (): void => state.presentation.setAskOpen(false);
  const content = () => createElement(AskSessionProvider, { value: session }, createElement(AskPanel, { onClose: close }));
  let remove: (() => void) | undefined;
  const sync = (): void => {
    const open = state.presentation.view.getState().askOpen;
    if (open && remove === undefined) remove = panels.register({ id: ASK_PANEL_ID, title: ASK_COPY.title, placement: { kind: 'floating', side: 'right', top: INSPECTOR_PANEL_TOP }, initialWidth: ASK_PANEL_WIDTH, content });
    else if (!open && remove !== undefined) {
      remove();
      remove = undefined;
    }
  };
  const unsubscribe = state.presentation.view.subscribe(sync);
  const unregister = registerAiAction('ask', () => state.presentation.setAskOpen(!state.presentation.view.getState().askOpen));
  sync();
  return () => {
    unsubscribe();
    unregister();
    remove?.();
    remove = undefined;
  };
}
