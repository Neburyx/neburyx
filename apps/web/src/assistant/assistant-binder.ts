import { createElement } from 'react';
import { registerAiAction } from '../ai/ai-actions.js';
import { INSPECTOR_PANEL_TOP } from '../inspector/inspector-layout.js';
import { isSourceChanged } from '../state/investigation-state.js';
import type { ClientState } from '../state/client-state.js';
import type { PanelRegistry } from '../workspace/panel-registry.js';
import { AssistantPanel } from './assistant-panel.js';
import { AssistantSessionProvider, createAssistantSession, type AssistantSession } from './assistant-session.js';
import { ASSISTANT_COPY } from './copy.js';
import { ASSISTANT_PANEL_ID, ASSISTANT_PANEL_WIDTH } from './panel-layout.js';

/** Lives outside React: the panel is registered while the assistant is open, and the thread outlives the panel. A change of investigation, masking or source clears the thread here, so an answer shown under the old state is gone before it can be seen again. */
export function bindAssistantPanel(state: ClientState, panels: PanelRegistry, session: AssistantSession = createAssistantSession()): () => void {
  const close = (): void => state.presentation.setAssistantOpen(false);
  const content = () => createElement(AssistantSessionProvider, { value: session }, createElement(AssistantPanel, { onClose: close }));
  let remove: (() => void) | undefined;
  const syncPanel = (): void => {
    const open = state.presentation.view.getState().assistantOpen;
    if (open && remove === undefined) remove = panels.register({ id: ASSISTANT_PANEL_ID, title: ASSISTANT_COPY.title, placement: { kind: 'floating', side: 'right', top: INSPECTOR_PANEL_TOP }, initialWidth: ASSISTANT_PANEL_WIDTH, content });
    else if (!open && remove !== undefined) {
      remove();
      remove = undefined;
    }
  };
  const syncThread = (): void => {
    const held = session.store.getState();
    const investigation = state.investigation.getState();
    const mask = state.mask.getState();
    if (held.investigationId !== investigation.id) {
      session.clear({ investigationId: investigation.id, mask });
      return;
    }
    if (held.mask !== mask) {
      session.clear({ mask, notice: held.turns.length === 0 ? undefined : { kind: 'masking-cleared' } });
      return;
    }
    if (isSourceChanged(investigation.record?.sourceState) && held.turns.length > 0) session.clear({ notice: { kind: 'source-changed' } });
  };
  const stops = [state.presentation.view.subscribe(syncPanel), state.investigation.subscribe(syncThread), state.mask.subscribe(syncThread)];
  const unregister = registerAiAction('assistant', () => state.presentation.setAssistantOpen(!state.presentation.view.getState().assistantOpen));
  syncThread();
  syncPanel();
  return () => {
    for (const stop of stops) stop();
    unregister();
    remove?.();
    remove = undefined;
  };
}
