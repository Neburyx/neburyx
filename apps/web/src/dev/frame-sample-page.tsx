import { useEffect, useState } from 'react';
import { ProfileProvider } from '../canvas/profile-context.js';
import type { ProfileState, ProfileStore } from '../canvas/profile-store.js';
import type { ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { createStore, readable } from '../state/store.js';
import { registerBuiltInMenuItems } from '../workspace/built-in-menu-items.js';
import { registerBuiltInSlots } from '../workspace/built-in-slots.js';
import { registerBuiltInTools } from '../workspace/built-in-tools.js';
import { bindFiltersPanel } from '../workspace/filters-binder.js';
import { registerFiltersTool } from '../workspace/filters-tool.js';
import { registerBuiltInKeyBindings } from '../workspace/built-in-key-bindings.js';
import { createKeyBindingRegistry, KeyBindingsProvider } from '../workspace/key-binding-registry.js';
import { createMenuRegistry, MenuProvider } from '../workspace/menu-registry.js';
import { createSelectionActionRegistry, SelectionActionsProvider } from '../workspace/selection-actions.js';
import { bindBuiltInEvidence } from '../evidence/built-in.js';
import { bindBuiltInCompare } from '../compare/built-in.js';
import { createEdgeReadStore, EdgeReadProvider } from '../evidence/edge-read.js';
import { bindBuiltInInspector } from '../inspector/built-in-tabs.js';
import { createShellData, ShellDataProvider } from '../shell/shell-data.js';
import { sampleClient } from './sample-client.js';
import { bindLegend } from '../workspace/legend-binder.js';
import { bindSupernodePanel } from '../workspace/supernode-panel-binder.js';
import { createPanelRegistryFor, PanelsProvider } from '../workspace/panel-registry.js';
import { createSlotRegistry, SlotsProvider } from '../workspace/slots.js';
import { createToolRegistry, ToolsProvider } from '../workspace/tool-registry.js';
import { WorkspaceShell } from '../workspace/workspace-shell.js';
import { ShortcutSheet } from '../workspace/shortcut-sheet.js';
import type { SourceProfile } from '@neburyx/contracts';
import { FIXTURE_RECORD } from './fixture-loader.js';
import { createFrameSampleState, frameSampleProfile, FRAME_SAMPLE_SOURCE } from './frame-sample.js';
import { markStandInKey, registerStandInActions, registerStandInKeyBindings, registerStandInMenuItems, registerStandInPanels, registerStandInTools, registerStandIns } from './stand-ins.js';

const LONG_LABEL_LENGTH = 60;

/** The sample's profile, with more neutral entity types when the address says `?legendTypes=40`, and the first type's label as one unbroken word of 60 characters when it says `?legendLabel=long`, to try the legend with a long list and a long label. */
export function sampleProfile(search: string): SourceProfile {
  const base = frameSampleProfile();
  const params = new URLSearchParams(search);
  const extra = Math.max(0, Number(params.get('legendTypes') ?? 0) - base.entityTypes.length);
  const template = base.entityTypes[0];
  const more = template === undefined ? [] : Array.from({ length: extra }, (_unused, index) => ({ ...template, type: `kind-${index}`, label: `Kind ${index}`, displayName: `Kind ${index}` }));
  const entityTypes = [...base.entityTypes, ...more].map((type, index) => (index === 0 && params.get('legendLabel') === 'long' ? { ...type, label: 'W'.repeat(LONG_LABEL_LENGTH), displayName: 'W'.repeat(LONG_LABEL_LENGTH) } : type));
  if (params.get('links') !== 'on') return { ...base, entityTypes };
  const linked = entityTypes.map((type) => (type.type === 'holder' ? { ...type, recordLink: 'always' as const } : type));
  return { ...base, entityTypes: linked, relationshipTypes: [{ type: 'HAS_LINE', from: 'holder', to: 'line', aggregate: false, observedAt: null, stableIdProperty: 'id', filterable: [], sortable: [], evidence: ['recordId'], properties: ['id', 'recordId'], recordLink: true }] };
}

/** `?links=on` gives the holder type and the HAS_LINE relationship a source record link, and its records answer as linkable. */
function linksOn(search: string): boolean {
  return new URLSearchParams(search).get('links') === 'on';
}

function knownProfile(): ProfileStore {
  const store = createStore<ProfileState>({ sourceId: FRAME_SAMPLE_SOURCE, request: { phase: 'ready', data: sampleProfile(window.location.search) } });
  return { ...readable(store), reload: () => undefined };
}

/** The sample, with the investigation's title taken from the address (`?title=...`) to try a long one in the header. */
export function titledSample(search: string): ClientState {
  const state = createFrameSampleState();
  const title = new URLSearchParams(search).get('title');
  if (title !== null && title !== '') state.describeInvestigation({ ...FIXTURE_RECORD, title });
  return state;
}

/** `?dock=none` leaves the dock test panel out, so the canvas has the whole width. The floating test panel covers part of the graph, so this page leaves it out unless the address asks for it: `?floating` puts it on the right, `?floating=left` on the left. */
function floatingSide(search: string): 'left' | 'right' | false {
  const value = new URLSearchParams(search).get('floating');
  if (value === null) return false;
  return value === 'left' ? 'left' : 'right';
}

/** `?evidence=on` binds the relationship evidence panel, which takes the dock, so the dock test panel is left out; its reads are answered by the sample's own client. */
function evidenceOn(search: string): boolean {
  return new URLSearchParams(search).get('evidence') === 'on';
}

/** `?compare=on` binds the comparison: Compare on the selection bar and in the menus, and its panel in the dock, so the dock test panel is left out. */
function compareOn(search: string): boolean {
  return new URLSearchParams(search).get('compare') === 'on';
}

/** The workspace with the Explore design's graph, drawn at the design's own positions, for putting the canvas beside the design. */
export function FrameSamplePage() {
  const [state] = useState(() => titledSample(window.location.search));
  const [profile] = useState(knownProfile);
  const [actions] = useState(() => createSelectionActionRegistry());
  // after the children's effects, so that a real action is registered first and its place is left alone
  useEffect(() => registerStandInActions(actions), [actions]);
  const [slots] = useState(() => {
    const registry = createSlotRegistry();
    registerBuiltInSlots(registry);
    registerStandIns(registry);
    return registry;
  });
  const [tools] = useState(() => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry);
    registerFiltersTool(registry, state);
    registerStandInTools(registry);
    return registry;
  });
  const [registries] = useState(() => {
    const registry = createPanelRegistryFor(state);
    bindLegend(state, registry);
    bindSupernodePanel(state, registry);
    bindFiltersPanel(state, registry);
    const { inspector } = bindBuiltInInspector(state, registry);
    const menuRegistry = createMenuRegistry();
    registerBuiltInMenuItems(menuRegistry);
    const evidenceBound = evidenceOn(window.location.search) ? bindBuiltInEvidence(state, registry, inspector, menuRegistry) : undefined;
    if (compareOn(window.location.search)) bindBuiltInCompare(state, registry, menuRegistry, actions, evidenceBound?.evidence);
    registerStandInMenuItems(menuRegistry);
    registerStandInPanels(registry, { floating: floatingSide(window.location.search), dock: new URLSearchParams(window.location.search).get('dock') !== 'none' && !evidenceOn(window.location.search) && !compareOn(window.location.search) });
    return [registry, menuRegistry] as const;
  });
  const [panels, menus] = registries;
  const [client] = useState(() => sampleClient(linksOn(window.location.search)));
  const [edgeReads] = useState(() => createEdgeReadStore(client, () => 'frame-sample', () => 'frame-sample'));
  const [shell] = useState(() => (evidenceOn(window.location.search) ? createShellData(client) : undefined));
  const [keyBindings] = useState(() => {
    const registry = createKeyBindingRegistry();
    registerBuiltInKeyBindings(registry);
    registerStandInKeyBindings(registry, markStandInKey);
    return registry;
  });
  return (
    <ClientStateProvider state={state}>
      <SlotsProvider registry={slots}>
        <SelectionActionsProvider registry={actions}>
          <ToolsProvider registry={tools}>
            <MenuProvider registry={menus}>
              <PanelsProvider registry={panels}>
                <KeyBindingsProvider registry={keyBindings}>
                  <ShortcutSheet />
                  <ProfileProvider store={profile}>
                    {shell === undefined ? (
                      <WorkspaceShell canvasView="as-drawn" />
                    ) : (
                      <ShellDataProvider store={shell}>
                        <EdgeReadProvider store={edgeReads}>
                          <WorkspaceShell canvasView="as-drawn" />
                        </EdgeReadProvider>
                      </ShellDataProvider>
                    )}
                  </ProfileProvider>
                </KeyBindingsProvider>
              </PanelsProvider>
            </MenuProvider>
          </ToolsProvider>
        </SelectionActionsProvider>
      </SlotsProvider>
    </ClientStateProvider>
  );
}
