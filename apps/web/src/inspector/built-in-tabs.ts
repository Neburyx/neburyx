import { OverviewTab } from './overview-tab.js';
import { PropertiesTab } from './properties-tab.js';
import type { ClientState } from '../state/client-state.js';
import type { PanelRegistry } from '../workspace/panel-registry.js';
import { bindInspector } from './inspector-binder.js';
import { createInspector, type Inspector } from './inspector.js';

/** The tabs this feature draws; the Relationships and Evidence tabs are registered by the features that build them. */
export function registerBuiltInInspectorTabs(inspector: Inspector): () => void {
  const removers = [inspector.tabs.register({ id: 'overview', label: 'Overview', order: 10, content: OverviewTab }), inspector.tabs.register({ id: 'properties', label: 'Properties', order: 20, content: PropertiesTab })];
  return () => {
    for (const remove of removers) remove();
  };
}

/** The inspector of an app: its panel bound to the selection and the tabs it draws. The function it returns takes all of it away. */
export function bindBuiltInInspector(state: ClientState, panels: PanelRegistry): { readonly inspector: Inspector; readonly unbind: () => void } {
  const inspector = createInspector();
  const removeTabs = registerBuiltInInspectorTabs(inspector);
  const unbindPanel = bindInspector(state, panels, inspector);
  return {
    inspector,
    unbind: () => {
      unbindPanel();
      removeTabs();
    },
  };
}
