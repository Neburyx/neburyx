import { WALK_SENTENCE } from './canvas/graph-canvas.js';
import { render } from '@testing-library/react';
import { useMemo } from 'react';
import { vi } from 'vitest';
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
import { bindBannerToInvestigation } from './banner/bind-investigation.js';
import { BannerProvider } from './banner/banner-context.js';
import { createBannerController, type BannerController } from './banner/banner-controller.js';
import { createBuiltInBannerController } from './banner/built-in-causes.js';
import { ProfileProvider } from './canvas/profile-context.js';
import { createProfileStore, type ProfileState, type ProfileStore } from './canvas/profile-store.js';
import { RendererProvider } from './canvas/renderer-context.js';
import type { CanvasEvents, CanvasRenderer, CreateRenderer, Scene } from './canvas/scene.js';
import type { Position, Viewport } from './state/presentation-state.js';
import { registerBuiltInKeyBindings } from './workspace/built-in-key-bindings.js';
import { createKeyBindingRegistry, KeyBindingsProvider, type KeyBindingRegistry } from './workspace/key-binding-registry.js';
import { createMenuRegistry, MenuProvider, type MenuRegistry } from './workspace/menu-registry.js';
import { createSelectionActionRegistry, SelectionActionsProvider, type SelectionActionRegistry } from './workspace/selection-actions.js';
import { bindLegend } from './workspace/legend-binder.js';
import { bindSupernodePanel } from './workspace/supernode-panel-binder.js';
import { bindSearchPanel } from './search/search-panel-binder.js';
import { bindFiltersPanel } from './workspace/filters-binder.js';
import type { Evidence } from './evidence/evidence.js';
import { bindPatternsPanel } from './patterns/patterns-binder.js';
import { createPanelRegistryFor, PanelsProvider, type PanelRegistry } from './workspace/panel-registry.js';
import { createSlotRegistry, SlotsProvider, type SlotRegistry } from './workspace/slots.js';
import { createToolRegistry, ToolsProvider, type ToolRegistry } from './workspace/tool-registry.js';
import { WorkspaceShell } from './workspace/workspace-shell.js';

export function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return { principal: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Local user', role: 'administrator' }, edition: 'community', identityMode: 'none', sources: [], ...overrides };
}

export function source(id: string, overrides: Partial<SourceSummary> = {}): SourceSummary {
  return { id, alias: `Source ${id}`, state: 'connected', stateReason: null, readOnly: true, synthetic: true, lastTestAt: null, lastTest: null, mappingSummary: { entityTypes: 1, relationshipTypes: 1, derivedRules: 0 }, demoCase: null, ...overrides };
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
  readonly restores: Array<Viewport | undefined>;
  readonly zooms: number[];
  readonly centered: string[];
  readonly shown: Viewport[];
  /** The positions given to `placeLive`, in order, and how many times `endLive` was called. */
  readonly lives: Array<ReadonlyMap<string, { x: number; y: number }>>;
  liveEnds: number;
  /** Makes `placeLive` throw. */
  failLive?: boolean;
  fits: number;
  /** How many of the fits left the aggregate nodes out. */
  entityFits: number;
  disposed: number;
}

export interface StubOptions {
  readonly failOn?: 'mount' | 'draw';
  /** With `failOn: 'draw'`, the number of draws that fail before the renderer draws again. */
  readonly failDraws?: number;
  readonly failCreate?: boolean;
  /** Makes `fit`, `zoomBy` and `centerOn` throw. */
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
    restores: [],
    zooms: [],
    centered: [],
    shown: [],
    fits: 0,
    lives: [],
    liveEnds: 0,
    entityFits: 0,
    disposed: 0,
    mount(container, events, viewport) {
      if (options.failOn === 'mount') throw new Error('no drawing surface');
      stub.mounts.push(container);
      stub.events.push(events);
      stub.startViewports.push(viewport);
    },
    draw(scene, restore) {
      if (options.failOn === 'draw' && failures > 0) {
        failures -= 1;
        throw new Error('cannot draw');
      }
      stub.scenes.push(scene);
      stub.restores.push(restore);
      drawn = scene;
    },
    show(viewport) {
      stub.shown.push(viewport);
    },
    fit(entitiesOnly) {
      if (options.failCommands === true) throw new Error('cannot fit');
      stub.fits += 1;
      if (entitiesOnly === true) stub.entityFits += 1;
    },
    placeLive(positions) {
      if (stub.failLive === true) throw new Error('cannot place');
      stub.lives.push(new Map(positions));
    },
    endLive() {
      stub.liveEnds += 1;
    },
    centerOn(key) {
      if (options.failCommands === true) throw new Error('cannot centre');
      stub.centered.push(key);
    },
    zoomBy(factor) {
      if (options.failCommands === true) throw new Error('cannot zoom');
      stub.zooms.push(factor);
    },
    anchorOf: (key) => {
      if (drawn === undefined) return undefined;
      if (key === undefined) return { x: 500, y: 400 };
      const entity = drawn.entities.find((candidate) => candidate.id === key);
      if (entity !== undefined) return { x: entity.position.x + 10, y: entity.position.y + 20 };
      return drawn.relationships.some((candidate) => candidate.id === key) ? { x: 300, y: 350 } : undefined;
    },
    describe: () => ({ entities: drawn?.entities.filter((entity) => entity.remainder !== true).length ?? 0, relationships: drawn?.relationships.filter((relationship) => relationship.remainder !== true).length ?? 0 }),
    viewport: () => ({ zoom: 1, x: 0, y: 0 }),
    positions: () => new Map((drawn?.entities ?? []).map((entity) => [entity.id, entity.position])),
    inspect: () => ({ fits: 0, viewport: { zoom: 1, x: 0, y: 0 }, zoomLimits: { min: 0.1, max: 4 }, boundingBox: undefined, interaction: { panning: false, zooming: false, boxSelecting: false, nodesGrabbable: false, nodesSelectable: false }, remainders: [], nodes: [], edges: [] }),
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

/** A registry with the workspace's own bindings, on macOS (⌘, as the design shows its hints), so a test does not depend on the machine it runs on. */
export function builtInKeyBindings(platform: 'mac' | 'other' = 'mac'): KeyBindingRegistry {
  const registry = createKeyBindingRegistry(platform);
  registerBuiltInKeyBindings(registry);
  return registry;
}

/** The app with the banner controller the product builds, and a spy on what is reported to it, for a test that a feature does not use the banner. */
export function renderAppWithCauses(path: Parameters<typeof renderApp>[0], client: ApiClient, state?: ClientState) {
  const view = renderApp(path, client, state, undefined, undefined, undefined, undefined, undefined, undefined, undefined, createBuiltInBannerController());
  return { ...view, reported: vi.spyOn(view.banner, 'showFailure') };
}

export function renderApp(path: string | { readonly pathname: string; readonly search?: string; readonly state?: unknown }, client: ApiClient, state: ClientState = createClientState(), slots: SlotRegistry = createSlotRegistry(), createRenderer: CreateRenderer = stubFactory().create, selectionActions: SelectionActionRegistry = createSelectionActionRegistry(), tools: ToolRegistry = createToolRegistry(), menus: MenuRegistry = createMenuRegistry(), panels: PanelRegistry = createPanelRegistryFor(state), keyBindings: KeyBindingRegistry = builtInKeyBindings(), banner: BannerController = createBannerController(), evidence?: Evidence): { readonly banner: BannerController; readonly router: ReturnType<typeof createMemoryRouter>; readonly state: ClientState; readonly slots: SlotRegistry; readonly tools: ToolRegistry; readonly panels: PanelRegistry; readonly keyBindings: KeyBindingRegistry; readonly container: HTMLElement; readonly unmount: () => void } {
  const router = createMemoryRouter(appRoutes(client, state, banner), { initialEntries: [path] });
  const view = render(
    <ClientStateProvider state={state}>
      <BannerProvider controller={banner}>
        <SlotsProvider registry={slots}>
          <SelectionActionsProvider registry={selectionActions}>
            <ToolsProvider registry={tools}>
              <MenuProvider registry={menus}>
                <PanelsProvider registry={panels}>
                  <KeyBindingsProvider registry={keyBindings}>
                    <RendererProvider createRenderer={createRenderer}>
                      <RouterProvider router={router} />
                    </RendererProvider>
                  </KeyBindingsProvider>
                </PanelsProvider>
              </MenuProvider>
            </ToolsProvider>
          </SelectionActionsProvider>
        </SlotsProvider>
      </BannerProvider>
    </ClientStateProvider>,
  );
  const unbindLegend = bindLegend(state, panels);
  const unbindSearch = bindSearchPanel(state, panels);
  const unbindFilters = bindFiltersPanel(state, panels);
  const unbindPatterns = bindPatternsPanel(state, panels, evidence);
  const unbindSupernode = bindSupernodePanel(state, panels);
  const unbindBanner = bindBannerToInvestigation(state, banner);
  return {
    banner,
    router,
    state,
    slots,
    tools,
    panels,
    keyBindings,
    container: view.container,
    unmount: () => {
      unbindLegend();
      unbindSearch();
      unbindFilters();
      unbindPatterns();
      unbindSupernode();
      unbindBanner();
      view.unmount();
    },
  };
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
  const panels = useMemo(() => {
    const registry = createPanelRegistryFor(clientState);
    bindLegend(clientState, registry);
    bindSupernodePanel(clientState, registry);
    return registry;
  }, [clientState]);
  const keyBindings = useMemo(() => builtInKeyBindings(), []);
  const createRenderer = useMemo(() => injectedRenderer ?? stubFactory().create, [injectedRenderer]);
  return (
    <ClientStateProvider state={clientState}>
      <SlotsProvider registry={slots}>
        <SelectionActionsProvider registry={selectionActions}>
          <ToolsProvider registry={tools}>
            <MenuProvider registry={menus}>
              <PanelsProvider registry={panels}>
                <KeyBindingsProvider registry={keyBindings}>
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
                </KeyBindingsProvider>
              </PanelsProvider>
            </MenuProvider>
          </ToolsProvider>
        </SelectionActionsProvider>
      </SlotsProvider>
    </ClientStateProvider>
  );
}

/** The element a query found; a test that needs it fails by name when it is not there. */
export function need<T extends Element>(found: T | null | undefined, what = 'the element'): T {
  if (found === null || found === undefined) throw new Error(`${what} is not in the page`);
  return found;
}

function rectOf(width: number, height: number): DOMRectReadOnly {
  return { x: 0, y: 0, top: 0, left: 0, width, height, right: width, bottom: height, toJSON: () => ({}) };
}

/** Stands in for the browser's size observer, which jsdom does not have: `resize` tells every observer of an element that its size is now `width` by `height`, and the element's own measured size is that from then on. */
export function stubSizeObserver(): { readonly resize: (element: Element, width: number, height?: number) => void; readonly observed: () => readonly Element[]; readonly restore: () => void } {
  const watchers = new Set<{ readonly element: Element; readonly callback: ResizeObserverCallback; readonly observer: ResizeObserver }>();
  const sizes = new Map<Element, { readonly width: number; readonly height: number }>();
  const original = globalThis.ResizeObserver;
  const originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const size = sizes.get(this);
    return { ...originalRect.call(this), width: size?.width ?? 0, height: size?.height ?? 0 };
  };
  globalThis.ResizeObserver = class implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}

    observe(element: Element): void {
      watchers.add({ element, callback: this.callback, observer: this });
    }

    unobserve(element: Element): void {
      for (const watcher of watchers) if (watcher.observer === this && watcher.element === element) watchers.delete(watcher);
    }

    disconnect(): void {
      for (const watcher of watchers) if (watcher.observer === this) watchers.delete(watcher);
    }
  };
  return {
    resize(element, width, height = 0) {
      sizes.set(element, { width, height });
      const entry: ResizeObserverEntry = { target: element, contentRect: rectOf(width, height), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] };
      for (const watcher of [...watchers]) if (watcher.element === element) watcher.callback([entry], watcher.observer);
    },
    observed: () => [...watchers].map((watcher) => watcher.element),
    restore() {
      globalThis.ResizeObserver = original;
      Element.prototype.getBoundingClientRect = originalRect;
    },
  };
}

/** Makes every canvas answer drawing calls with nothing, so the renderer can mount on a real element in jsdom, which has no canvas; returns the function that puts the canvases back. The assertion is the one place a stand-in is told it is a drawing context: a proxy cannot be built to satisfy the interface. */
export function stubCanvasContext(): () => void {
  const context = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === 'measureText') return () => ({ width: 0 });
        if (key === 'createLinearGradient' || key === 'createPattern') return () => ({ addColorStop: () => undefined });
        return key === 'canvas' ? document.createElement('canvas') : () => undefined;
      },
      set: () => true,
    },
  );
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D);
  return () => spy.mockRestore();
}

/** What a canvas says about the graph it holds, without the sentence on walking it. */
export function canvasSummary(canvas: HTMLElement): string | undefined {
  const text = document.getElementById(canvas.getAttribute('aria-describedby') ?? '')?.textContent;
  return text?.replace(`. ${WALK_SENTENCE}`, '');
}
