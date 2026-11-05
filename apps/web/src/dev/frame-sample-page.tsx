import { useState } from 'react';
import { ProfileProvider } from '../canvas/profile-context.js';
import type { ProfileState, ProfileStore } from '../canvas/profile-store.js';
import { ClientStateProvider } from '../state/context.js';
import { createStore, readable } from '../state/store.js';
import { registerBuiltInMenuItems } from '../workspace/built-in-menu-items.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { registerBuiltInTools } from '../workspace/built-in-tools.js';
import { createMenuRegistry, MenuProvider } from '../workspace/menu-registry.js';
import { createSelectionActionRegistry, SelectionActionsProvider } from '../workspace/selection-actions.js';
import { bindLegend } from '../workspace/legend-binder.js';
import { createPanelRegistryFor, PanelsProvider } from '../workspace/panel-registry.js';
import { createSlotRegistry, SlotsProvider } from '../workspace/slots.js';
import { createToolRegistry, ToolsProvider } from '../workspace/tool-registry.js';
import { WorkspaceShell } from '../workspace/workspace-shell.js';
import type { SourceProfile } from '@neburyx/contracts';
import { createFrameSampleState, frameSampleProfile, FRAME_SAMPLE_SOURCE } from './frame-sample.js';
import { registerStandInActions, registerStandInMenuItems, registerStandInPanels, registerStandInTools, registerStandIns } from './stand-ins.js';

const LONG_LABEL_LENGTH = 60;

/** The sample's profile, with more neutral entity types when the address says `?legendTypes=40`, and the first type's label as one unbroken word of 60 characters when it says `?legendLabel=long`, to try the legend with a long list and a long label. */
export function sampleProfile(search: string): SourceProfile {
  const base = frameSampleProfile();
  const params = new URLSearchParams(search);
  const extra = Math.max(0, Number(params.get('legendTypes') ?? 0) - base.entityTypes.length);
  const template = base.entityTypes[0];
  const more = template === undefined ? [] : Array.from({ length: extra }, (_unused, index) => ({ ...template, type: `kind-${index}`, label: `Kind ${index}`, displayName: `Kind ${index}` }));
  const entityTypes = [...base.entityTypes, ...more].map((type, index) => (index === 0 && params.get('legendLabel') === 'long' ? { ...type, label: 'W'.repeat(LONG_LABEL_LENGTH), displayName: 'W'.repeat(LONG_LABEL_LENGTH) } : type));
  return { ...base, entityTypes };
}

function knownProfile(): ProfileStore {
  const store = createStore<ProfileState>({ sourceId: FRAME_SAMPLE_SOURCE, request: { phase: 'ready', data: sampleProfile(window.location.search) } });
  return { ...readable(store), reload: () => undefined };
}

/** The floating test panel covers part of the graph, so this page leaves it out unless the address asks for it: `?floating` puts it on the right, `?floating=left` on the left. */
function floatingSide(search: string): 'left' | 'right' | false {
  const value = new URLSearchParams(search).get('floating');
  if (value === null) return false;
  return value === 'left' ? 'left' : 'right';
}

/** The workspace with the Explore design's graph, drawn at the design's own positions, for putting the canvas beside the design. */
export function FrameSamplePage() {
  const [state] = useState(createFrameSampleState);
  const [profile] = useState(knownProfile);
  const [actions] = useState(() => {
    const registry = createSelectionActionRegistry();
    registerStandInActions(registry);
    return registry;
  });
  const [slots] = useState(() => {
    const registry = createSlotRegistry();
    registerBuiltInSlots(registry);
    registerStandIns(registry);
    return registry;
  });
  const [tools] = useState(() => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry);
    registerStandInTools(registry);
    return registry;
  });
  const [menus] = useState(() => {
    const registry = createMenuRegistry();
    registerBuiltInMenuItems(registry);
    registerStandInMenuItems(registry);
    return registry;
  });
  const [panels] = useState(() => {
    const registry = createPanelRegistryFor(state);
    bindLegend(state, registry);
    registerStandInPanels(registry, { floating: floatingSide(window.location.search) });
    return registry;
  });
  return (
    <ClientStateProvider state={state}>
      <SlotsProvider registry={slots}>
        <SelectionActionsProvider registry={actions}>
          <ToolsProvider registry={tools}>
            <MenuProvider registry={menus}>
              <PanelsProvider registry={panels}>
                <ProfileProvider store={profile}>
                  <WorkspaceShell canvasView="as-drawn" />
                </ProfileProvider>
              </PanelsProvider>
            </MenuProvider>
          </ToolsProvider>
        </SelectionActionsProvider>
      </SlotsProvider>
    </ClientStateProvider>
  );
}
