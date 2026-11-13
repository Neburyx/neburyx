import type { ClientState } from '../state/client-state.js';
import { TOOL_ORDER, type ToolRegistry } from '../workspace/tool-registry.js';
import { PATTERNS_COPY } from './copy.js';

export const PATTERNS_TOOL_ID = 'patterns';

/** The tool strip's button for the panel, to give the focus back to when the panel is closed from inside. */
export function focusPatternsTool(): void {
  document.querySelector<HTMLElement>(`.tool-strip [aria-label="${PATTERNS_COPY.title}"]`)?.focus();
}

export function registerPatternsTool(registry: ToolRegistry, state: ClientState): () => void {
  return registry.register({
    id: PATTERNS_TOOL_ID,
    label: PATTERNS_COPY.title,
    icon: <span className="icon icon-patterns" aria-hidden="true" />,
    order: TOOL_ORDER.patterns,
    kind: {
      type: 'action',
      activate: () => state.presentation.setPatternsOpen(!state.presentation.view.getState().patternsOpen),
      isActive: (presentation) => presentation.patternsOpen,
    },
  });
}
