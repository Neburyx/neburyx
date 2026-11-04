import { render } from '@testing-library/react';
import { useMemo } from 'react';
import type { MeResponse, SourceProfile, SourceSummary, SourceTestReport } from '@neburyx/contracts';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router';
import type { ApiClient } from './api/client.js';
import { fakeClient } from './api/fake-client.js';
import { testProfile } from './dev/test-profile.js';
import { appRoutes } from './routes.js';
import { createShellData, ShellDataProvider, useShellData, type ShellData } from './shell/shell-data.js';
import { createClientState, type ClientState } from './state/client-state.js';
import { createStore, readable, type ReadableStore } from './state/store.js';
import { ClientStateProvider } from './state/context.js';
import { ProfileProvider } from './canvas/profile-context.js';
import { createProfileStore, type ProfileState, type ProfileStore } from './canvas/profile-store.js';
import { RendererProvider } from './canvas/renderer-context.js';
import type { CanvasEvents, CanvasRenderer, CreateRenderer, Scene } from './canvas/scene.js';
import type { Position, Viewport } from './state/presentation-state.js';
import { createMenuRegistry, MenuProvider, type MenuRegistry } from './workspace/menu-registry.js';
import { createSelectionActionRegistry, SelectionActionsProvider, type SelectionActionRegistry } from './workspace/selection-actions.js';
import { createSlotRegistry, SlotsProvider, type SlotRegistry } from './workspace/slots.js';
import { createToolRegistry, ToolsProvider, type ToolRegistry } from './workspace/tool-registry.js';
import { WorkspaceShell } from './workspace/workspace-shell.js';

export function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return { principal: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Local user', role: 'administrator' }, edition: 'community', identityMode: 'none', sources: [], ...overrides };
}

export function source(id: string, overrides: Partial<SourceSummary> = {}): SourceSummary {
  return { id, alias: `Source ${id}`, state: 'connected', stateReason: null, readOnly: true, synthetic: true, lastTestAt: null, lastTest: null, mappingSummary: { entityTypes: 1, relationshipTypes: 1, derivedRules: 0 }, ...overrides };
}

export function testReport(sourceId: string, overrides: Partial<SourceTestReport> = {}): SourceTestReport {
  return {
    schemaVersion: 1,
    sourceId,
    checkedAt: '2026-11-02T10:00:00.000Z',
    outcome: 'pass',
    state: 'connected',
    stateReason: null,
    server: { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community' },
    versionSupported: true,
    operations: [],
    readOnlyCheck: 'privileges-inspected',
    loginCanWrite: false,
    mappingChecks: { status: 'pass', findings: [] },
    degreeChecks: { status: 'pass', foundOn: 'neo4j', types: [{ entityType: 'thing', result: 'cheap', basis: 'degree-operator', relationshipTypes: ['LINKS'] }], warnings: [] },
    mappingSummary: { entityTypes: 1, relationshipTypes: 1, derivedRules: 0 },
    ...overrides,
  };
}

export function clientWith(parts: { readonly me?: MeResponse; readonly sources?: readonly SourceSummary[] }): ApiClient {
  return fakeClient({
    getProfile: async (sourceId) => ({ ok: true, value: testProfile(sourceId) }),
    getMe: async () => (parts.me === undefined ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : { ok: true, value: parts.me }),
    getSources: async () => (parts.sources === undefined ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : { ok: true, value: { items: [...parts.sources], nextCursor: null } }),
  });
}

export interface Counted {
  readonly client: ApiClient;
  readonly calls: { me: number; sources: number };
}

/** A profile store that has already answered for `sourceId`, or has not answered when `profile` is undefined. */
export function staticProfile(sourceId: string, profile: SourceProfile | undefined): ProfileStore {
  const store = createStore<ProfileState>({ sourceId, request: profile === undefined ? { phase: 'idle' } : { phase: 'ready', data: profile } });
  return { ...readable(store), reload: () => undefined };
}

/** Shell data that has already answered with the given edition, or has not answered when it is undefined. */
export function staticShell(edition: 'community' | 'enterprise' | undefined): ReadableStore<ShellData> {
  const reload = (): void => undefined;
  return readable(createStore<ShellData>({ me: edition === undefined ? { phase: 'idle' } : { phase: 'ready', data: me({ edition }) }, sources: { phase: 'idle' }, reload, reloadSources: reload }));
}

export function counted(client: ApiClient): Counted {
  const calls = { me: 0, sources: 0 };
  return {
    calls,
    client: {
      ...client,
      getMe: (signal) => {
        calls.me += 1;
        return client.getMe(signal);
      },
      getSources: (signal) => {
        calls.sources += 1;
        return client.getSources(signal);
      },
    },
  };
}

export interface StubRenderer extends CanvasRenderer {
  readonly mounts: Array<HTMLElement | undefined>;
  readonly events: CanvasEvents[];
  readonly startViewports: Array<Viewport | undefined>;
  readonly scenes: Scene[];
  readonly zooms: number[];
  fits: number;
  disposed: number;
}

export interface StubOptions {
  readonly failOn?: 'mount' | 'draw';
  /** With `failOn: 'draw'`, the number of draws that fail before the renderer draws again. */
  readonly failDraws?: number;
  readonly failCreate?: boolean;
  /** Makes `fit` and `zoomBy` throw. */
  readonly failCommands?: boolean;
}

/** A renderer that draws nothing and records what it was given. */
export function stubRenderer(options: StubOptions = {}): StubRenderer {
  let drawn: Scene | undefined;
  let failures = options.failDraws ?? Number.POSITIVE_INFINITY;
  const stub: StubRenderer = {
    mounts: [],
    events: [],
    startViewports: [],
    scenes: [],
    zooms: [],
    fits: 0,
    disposed: 0,
    mount(container, events, viewport) {
      if (options.failOn === 'mount') throw new Error('no drawing surface');
      stub.mounts.push(container);
      stub.events.push(events);
      stub.startViewports.push(viewport);
    },
    draw(scene) {
      if (options.failOn === 'draw' && failures > 0) {
        failures -= 1;
        throw new Error('cannot draw');
      }
      stub.scenes.push(scene);
      drawn = scene;
    },
    fit() {
      if (options.failCommands === true) throw new Error('cannot fit');
      stub.fits += 1;
    },
    zoomBy(factor) {
      if (options.failCommands === true) throw new Error('cannot zoom');
      stub.zooms.push(factor);
    },
    describe: () => ({ entities: drawn?.entities.length ?? 0, relationships: drawn?.relationships.length ?? 0 }),
    viewport: () => ({ zoom: 1, x: 0, y: 0 }),
    positions: () => new Map((drawn?.entities ?? []).map((entity) => [entity.id, entity.position])),
    inspect: () => ({ fits: 0, viewport: { zoom: 1, x: 0, y: 0 }, zoomLimits: { min: 0.1, max: 4 }, boundingBox: undefined, interaction: { panning: false, zooming: false, boxSelecting: false, nodesGrabbable: false, nodesSelectable: false }, nodes: [], edges: [] }),
    dispose() {
      stub.disposed += 1;
    },
  };
  return stub;
}

export function stubFactory(options: StubOptions = {}): { readonly create: CreateRenderer; readonly made: StubRenderer[] } {
  const made: StubRenderer[] = [];
  return {
    made,
    create: () => {
      if (options.failCreate === true) throw new Error('no renderer');
      const renderer = stubRenderer(options);
      made.push(renderer);
      return renderer;
    },
  };
}

export function renderApp(path: string, client: ApiClient, state: ClientState = createClientState(), slots: SlotRegistry = createSlotRegistry(), createRenderer: CreateRenderer = stubFactory().create, selectionActions: SelectionActionRegistry = createSelectionActionRegistry(), tools: ToolRegistry = createToolRegistry(), menus: MenuRegistry = createMenuRegistry()): { readonly router: ReturnType<typeof createMemoryRouter>; readonly state: ClientState; readonly slots: SlotRegistry; readonly tools: ToolRegistry; readonly container: HTMLElement; readonly unmount: () => void } {
  const router = createMemoryRouter(appRoutes(client, state), { initialEntries: [path] });
  const view = render(
    <ClientStateProvider state={state}>
      <SlotsProvider registry={slots}>
        <SelectionActionsProvider registry={selectionActions}>
          <ToolsProvider registry={tools}>
            <MenuProvider registry={menus}>
              <RendererProvider createRenderer={createRenderer}>
                <RouterProvider router={router} />
              </RendererProvider>
            </MenuProvider>
          </ToolsProvider>
        </SelectionActionsProvider>
      </SlotsProvider>
    </ClientStateProvider>,
  );
  return { router, state, slots, tools, container: view.container, unmount: view.unmount };
}

function Reloader() {
  const { reload } = useShellData();
  return <button onClick={reload}>Reload</button>;
}

/** The workspace shell with a button that reads the shell data again, for tests of a later read. */
export function WorkspaceHarness({ client, state, profile: injected, createRenderer: injectedRenderer }: { readonly client: ApiClient; readonly state?: ClientState; readonly profile?: ProfileStore; readonly createRenderer?: CreateRenderer }) {
  const clientState = useMemo(() => state ?? createClientState(), [state]);
  const store = useMemo(() => createShellData(client), [client]);
  const profile = useMemo(() => injected ?? createProfileStore(client, clientState.investigation), [injected, client, clientState]);
  const slots = useMemo(() => createSlotRegistry(), []);
  const selectionActions = useMemo(() => createSelectionActionRegistry(), []);
  const tools = useMemo(() => createToolRegistry(), []);
  const menus = useMemo(() => createMenuRegistry(), []);
  const createRenderer = useMemo(() => injectedRenderer ?? stubFactory().create, [injectedRenderer]);
  return (
    <ClientStateProvider state={clientState}>
      <SlotsProvider registry={slots}>
        <SelectionActionsProvider registry={selectionActions}>
          <ToolsProvider registry={tools}>
            <MenuProvider registry={menus}>
              <RendererProvider createRenderer={createRenderer}>
                <ShellDataProvider store={store}>
                  <ProfileProvider store={profile}>
                    <MemoryRouter initialEntries={['/explore']}>
                      <Reloader />
                      <WorkspaceShell />
                    </MemoryRouter>
                  </ProfileProvider>
                </ShellDataProvider>
              </RendererProvider>
            </MenuProvider>
          </ToolsProvider>
        </SelectionActionsProvider>
      </SlotsProvider>
    </ClientStateProvider>
  );
}
