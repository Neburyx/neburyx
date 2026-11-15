import type { ClientState } from '../state/client-state.js';
import { TOOL_ORDER, type ToolRegistry } from '../workspace/tool-registry.js';
import { PATHS_COPY } from './copy.js';

const PATHS_TOOL_ID = 'paths';

/** The tool strip's button for the panel, to give the focus back to when the panel is closed from inside. */
export function focusPathsTool(): void {
  document.querySelector<HTMLElement>(`.tool-strip [aria-label="${PATHS_COPY.toolLabel}"]`)?.focus();
}

export function registerPathsTool(registry: ToolRegistry, state: ClientState): () => void {
  return registry.register({
    id: PATHS_TOOL_ID,
    label: PATHS_COPY.toolLabel,
    icon: <span className="icon icon-paths" aria-hidden="true" />,
    order: TOOL_ORDER.paths,
    kind: {
      type: 'action',
      activate: () => state.presentation.setPathsOpen(!state.presentation.view.getState().pathsOpen),
      isActive: (presentation) => presentation.pathsOpen,
    },
  });
}
