import { ExploreFlyout } from './explore-flyout.js';
import { EXPLORE_TOOL_ID, TOOL_ORDER, type ToolRegistry } from './tool-registry.js';

export function registerBuiltInTools(registry: ToolRegistry): () => void {
  return registry.register({
    id: EXPLORE_TOOL_ID,
    label: 'Explore',
    icon: <span className="icon icon-select" aria-hidden="true" />,
    order: TOOL_ORDER.explore,
    kind: { type: 'flyout', content: ExploreFlyout },
  });
}
