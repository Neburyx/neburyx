import { createElement } from 'react';
import { registerAiAction } from '../ai/ai-actions.js';
import { INSPECTOR_PANEL_TOP } from '../inspector/inspector-layout.js';
import type { ClientState } from '../state/client-state.js';
import type { PanelRegistry } from '../workspace/panel-registry.js';
import { SUMMARY_COPY } from './copy.js';
import { SUMMARY_PANEL_ID, SUMMARY_PANEL_WIDTH } from './panel-layout.js';
import { SummaryPanel } from './summary-panel.js';
import { SummarySessionProvider, createSummarySession } from './summary-session.js';

/** Lives outside React: the panel is registered while the summary is open, and the draft outlives the panel. */
export function bindSummaryPanel(state: ClientState, panels: PanelRegistry): () => void {
  const session = createSummarySession();
  const close = (): void => state.presentation.setSummaryOpen(false);
  const returnToGraph = (): void => {
    close();
    document.querySelector<HTMLElement>('.graph-canvas')?.focus();
  };
  const content = () => createElement(SummarySessionProvider, { value: session }, createElement(SummaryPanel, { onClose: close, returnToGraph }));
  let remove: (() => void) | undefined;
  const sync = (): void => {
    const open = state.presentation.view.getState().summaryOpen;
    if (open && remove === undefined) remove = panels.register({ id: SUMMARY_PANEL_ID, title: SUMMARY_COPY.title, placement: { kind: 'floating', side: 'right', top: INSPECTOR_PANEL_TOP }, initialWidth: SUMMARY_PANEL_WIDTH, content });
    else if (!open && remove !== undefined) {
      remove();
      remove = undefined;
    }
  };
  const unsubscribe = state.presentation.view.subscribe(sync);
  const unregister = registerAiAction('summarize', () => {
    state.presentation.setAskOpen(false);
    state.presentation.setSummaryOpen(!state.presentation.view.getState().summaryOpen);
  });
  const unregisterNotes = registerAiAction('notes', () => {
    state.presentation.setAskOpen(false);
    state.presentation.openSummaryNotes();
  });
  sync();
  return () => {
    unsubscribe();
    unregister();
    unregisterNotes();
    remove?.();
    remove = undefined;
  };
}
