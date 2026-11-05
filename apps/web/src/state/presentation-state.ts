import { StateError } from './errors.js';
import { createStore, readable, type ReadableStore } from './store.js';

export interface Position {
  readonly x: number;
  readonly y: number;
}

export interface Viewport {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

/** Select is the default; Pan moves the view on a drag everywhere on empty canvas; Box select draws a box on a drag. Not saved with a view. */
export const POINTER_TOOLS = ['select', 'pan', 'box'] as const;

export type PointerTool = (typeof POINTER_TOOLS)[number];

export type MenuTargetKind = 'node' | 'relationship' | 'canvas';

/** The context menu that is open: what it is about, and the pointer's position in the browser window when it opened. Not saved with a view. */
export interface OpenMenu {
  readonly kind: MenuTargetKind;
  readonly key: string | undefined;
  readonly x: number;
  readonly y: number;
}

/** A flyout is open for the registration of a tool, so a tool taken out and registered again does not bring back a flyout that was open before. */
export interface OpenTool {
  readonly id: string;
  readonly registration: number;
}

export interface PresentationState {
  readonly tool: PointerTool;
  readonly selection: ReadonlySet<string>;
  readonly positions: ReadonlyMap<string, Position>;
  readonly pins: ReadonlySet<string>;
  readonly panelSizes: ReadonlyMap<string, number>;
  /** A panel is collapsed under the registration number it was collapsed with, so a panel taken out and registered again opens expanded. Not saved with a view. */
  readonly collapsedPanels: ReadonlyMap<string, number>;
  /** The legend is open. Not saved with a view, and kept when another source is bound. */
  readonly legendOpen: boolean;
  /** Undefined until a view was set, so that a view that was never set differs from a stored one at zoom 1. */
  readonly viewport: Viewport | undefined;
  /** The tool whose flyout is open, if any. Not saved with a view. */
  readonly openTool: OpenTool | undefined;
  readonly openMenu: OpenMenu | undefined;
}

export const INITIAL_PRESENTATION: PresentationState = {
  tool: 'select',
  selection: new Set(),
  positions: new Map(),
  pins: new Set(),
  panelSizes: new Map(),
  collapsedPanels: new Map(),
  legendOpen: false,
  viewport: undefined,
  openTool: undefined,
  openMenu: undefined,
};

/** What the investigation holds: a node key, or a node or relationship key. */
export interface KnownElements {
  readonly isNode: (key: string) => boolean;
  readonly isElement: (key: string) => boolean;
}

export interface PresentationActions {
  readonly view: ReadableStore<PresentationState>;
  setTool(tool: PointerTool): void;
  setOpenTool(open: OpenTool | undefined): void;
  setOpenMenu(open: OpenMenu | undefined): void;
  select(keys: readonly string[]): void;
  setPosition(key: string, position: Position): void;
  setPositions(positions: ReadonlyMap<string, Position>): void;
  pin(keys: readonly string[]): void;
  setPanelSize(panel: string, size: number): void;
  clearPanelSize(panel: string): void;
  setLegendOpen(open: boolean): void;
  setPanelCollapsed(panel: string, registration: number, collapsed: boolean): void;
  /** Lets go of a panel's collapsed state when that registration is taken out; the state of a newer registration of the same ID stays. */
  clearPanelCollapsed(panel: string, registration: number): void;
  setViewport(viewport: Viewport): void;
}

export interface PresentationStore extends PresentationActions {
  reset(): void;
  replacePins(keys: readonly string[]): void;
  prune(): void;
}

/** An element the investigation does not hold is refused; selection may name a node or a relationship, a position or a pin only a node. */
export function createPresentationStore(known: KnownElements): PresentationStore {
  const store = createStore<PresentationState>(INITIAL_PRESENTATION);
  const requireKnown = (keys: readonly string[], test: (key: string) => boolean): void => {
    if (!keys.every(test)) throw new StateError('UNKNOWN_ELEMENT');
  };
  return {
    view: readable(store),
    setTool(tool) {
      store.setState({ ...store.getState(), tool });
    },
    setOpenTool(open) {
      store.setState({ ...store.getState(), openTool: open });
    },
    setOpenMenu(open) {
      store.setState({ ...store.getState(), openMenu: open });
    },
    select(keys) {
      requireKnown(keys, known.isElement);
      store.setState({ ...store.getState(), selection: new Set(keys) });
    },
    setPosition(key, position) {
      requireKnown([key], known.isNode);
      store.setState({ ...store.getState(), positions: new Map(store.getState().positions).set(key, position) });
    },
    setPositions(positions) {
      requireKnown([...positions.keys()], known.isNode);
      store.setState({ ...store.getState(), positions: new Map([...store.getState().positions, ...positions]) });
    },
    pin(keys) {
      requireKnown(keys, known.isNode);
      store.setState({ ...store.getState(), pins: new Set([...store.getState().pins, ...keys]) });
    },
    replacePins(keys) {
      requireKnown(keys, known.isNode);
      store.setState({ ...store.getState(), pins: new Set(keys) });
    },
    setPanelSize(panel, size) {
      if (!Number.isFinite(size) || size <= 0) throw new StateError('INVALID_PANEL_SIZE');
      store.setState({ ...store.getState(), panelSizes: new Map(store.getState().panelSizes).set(panel, Math.max(1, Math.round(size))) });
    },
    setLegendOpen(legendOpen) {
      if (store.getState().legendOpen === legendOpen) return;
      store.setState({ ...store.getState(), legendOpen });
    },
    clearPanelCollapsed(panel, registration) {
      if (store.getState().collapsedPanels.get(panel) !== registration) return;
      const collapsedPanels = new Map(store.getState().collapsedPanels);
      collapsedPanels.delete(panel);
      store.setState({ ...store.getState(), collapsedPanels });
    },
    clearPanelSize(panel) {
      if (!store.getState().panelSizes.has(panel)) return;
      const panelSizes = new Map(store.getState().panelSizes);
      panelSizes.delete(panel);
      store.setState({ ...store.getState(), panelSizes });
    },
    setPanelCollapsed(panel, registration, collapsed) {
      const collapsedPanels = new Map(store.getState().collapsedPanels);
      if (collapsed) collapsedPanels.set(panel, registration);
      else collapsedPanels.delete(panel);
      store.setState({ ...store.getState(), collapsedPanels });
    },
    setViewport(viewport) {
      if (![viewport.zoom, viewport.x, viewport.y].every(Number.isFinite)) throw new StateError('INVALID_VIEWPORT');
      store.setState({ ...store.getState(), viewport });
    },
    prune() {
      const current = store.getState();
      const selection = [...current.selection].filter(known.isElement);
      const positions = [...current.positions].filter(([key]) => known.isNode(key));
      const pins = [...current.pins].filter(known.isNode);
      if (selection.length === current.selection.size && positions.length === current.positions.size && pins.length === current.pins.size) return;
      store.setState({ ...current, selection: new Set(selection), positions: new Map(positions), pins: new Set(pins) });
    },
    reset() {
      const { tool, panelSizes, collapsedPanels, legendOpen } = store.getState();
      store.setState({ ...INITIAL_PRESENTATION, tool, panelSizes, collapsedPanels, legendOpen });
    },
  };
}
