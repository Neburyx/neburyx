import type { ClientState } from '../state/client-state.js';
import { TOOL_ORDER, type ToolRegistry } from '../workspace/tool-registry.js';
import { SEARCH_PANEL_COPY } from './copy.js';

export const SEARCH_TOOL_ID = 'search';

/** The tool strip's button for the panel, to give the focus back to when the panel is closed from inside. */
export function focusSearchTool(): void {
  document.querySelector<HTMLElement>(`.tool-strip [aria-label="${SEARCH_PANEL_COPY.title}"]`)?.focus();
}

export function registerSearchTool(registry: ToolRegistry, state: ClientState): () => void {
  return registry.register({
    id: SEARCH_TOOL_ID,
    label: SEARCH_PANEL_COPY.title,
    icon: <span className="icon icon-find" aria-hidden="true" />,
    order: TOOL_ORDER.search,
    kind: {
      type: 'action',
      activate: () => (state.presentation.view.getState().searchOpen ? state.presentation.setSearchOpen(false) : state.presentation.requestSearch()),
      isActive: (presentation) => presentation.searchOpen,
    },
  });
}
