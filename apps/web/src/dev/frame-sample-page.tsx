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
import { createSlotRegistry, SlotsProvider } from '../workspace/slots.js';
import { createToolRegistry, ToolsProvider } from '../workspace/tool-registry.js';
import { WorkspaceShell } from '../workspace/workspace-shell.js';
import { createFrameSampleState, frameSampleProfile, FRAME_SAMPLE_SOURCE } from './frame-sample.js';
import { registerStandInActions, registerStandInMenuItems, registerStandInTools, registerStandIns } from './stand-ins.js';

function knownProfile(): ProfileStore {
  const store = createStore<ProfileState>({ sourceId: FRAME_SAMPLE_SOURCE, request: { phase: 'ready', data: frameSampleProfile() } });
  return { ...readable(store), reload: () => undefined };
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
  return (
    <ClientStateProvider state={state}>
      <SlotsProvider registry={slots}>
        <SelectionActionsProvider registry={actions}>
          <ToolsProvider registry={tools}>
            <MenuProvider registry={menus}>
              <ProfileProvider store={profile}>
                <WorkspaceShell canvasView="as-drawn" />
              </ProfileProvider>
            </MenuProvider>
          </ToolsProvider>
        </SelectionActionsProvider>
      </SlotsProvider>
    </ClientStateProvider>
  );
}
