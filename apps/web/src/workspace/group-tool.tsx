import type { ClientState } from '../state/client-state.js';
import { GROUP_PANEL_COPY } from './group-copy.js';
import { TOOL_ORDER, type ToolRegistry } from './tool-registry.js';

const GROUP_TOOL_ID = 'group';

/** The tool strip's button for the panel, to give the focus back to when the panel is closed from inside. */
export function focusGroupTool(): void {
  document.querySelector<HTMLElement>(`.tool-strip [aria-label="${GROUP_PANEL_COPY.title}"]`)?.focus();
}

export function registerGroupTool(registry: ToolRegistry, state: ClientState): () => void {
  return registry.register({
    id: GROUP_TOOL_ID,
    label: GROUP_PANEL_COPY.title,
    icon: <span className="icon icon-group" aria-hidden="true" />,
    order: TOOL_ORDER.group,
    kind: {
      type: 'action',
      activate: () => state.presentation.setGroupOpen(!state.presentation.view.getState().groupOpen),
      isActive: (presentation) => presentation.groupOpen,
    },
  });
}
