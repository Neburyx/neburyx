import { useState } from 'react';
import { ProfileProvider } from '../canvas/profile-context.js';
import type { ProfileState, ProfileStore } from '../canvas/profile-store.js';
import { ClientStateProvider } from '../state/context.js';
import { createStore, readable } from '../state/store.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { createSelectionActionRegistry, SelectionActionsProvider } from '../workspace/selection-actions.js';
import { createSlotRegistry, SlotsProvider } from '../workspace/slots.js';
import { WorkspaceShell } from '../workspace/workspace-shell.js';
import { createFrameSampleState, frameSampleProfile, FRAME_SAMPLE_SOURCE } from './frame-sample.js';
import { registerStandInActions, registerStandIns } from './stand-ins.js';

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
  return (
    <ClientStateProvider state={state}>
      <SlotsProvider registry={slots}>
        <SelectionActionsProvider registry={actions}>
          <ProfileProvider store={profile}>
            <WorkspaceShell canvasView="as-drawn" />
          </ProfileProvider>
        </SelectionActionsProvider>
      </SlotsProvider>
    </ClientStateProvider>
  );
}
