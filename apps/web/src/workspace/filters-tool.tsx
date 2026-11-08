import type { ClientState } from '../state/client-state.js';
import { FILTERS_PANEL_COPY } from './filters-copy.js';
import { TOOL_ORDER, type ToolRegistry } from './tool-registry.js';

export const FILTERS_TOOL_ID = 'filters';

/** The tool strip's button for the panel, to give the focus back to when the panel is closed from inside. */
export function focusFiltersTool(): void {
  document.querySelector<HTMLElement>(`.tool-strip [aria-label="${FILTERS_PANEL_COPY.title}"]`)?.focus();
}

export function registerFiltersTool(registry: ToolRegistry, state: ClientState): () => void {
  return registry.register({
    id: FILTERS_TOOL_ID,
    label: FILTERS_PANEL_COPY.title,
    icon: <span className="icon icon-filters" aria-hidden="true" />,
    order: TOOL_ORDER.filters,
    kind: {
      type: 'action',
      activate: () => state.presentation.setFiltersOpen(!state.presentation.view.getState().filtersOpen),
      isActive: (presentation) => presentation.filtersOpen,
    },
  });
}
