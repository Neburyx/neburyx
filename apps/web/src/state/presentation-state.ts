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

export type SearchTab = 'canvas' | 'source';

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
  /** The Search panel is open, and which of its tabs was last used. Not saved with a view, and kept when another source is bound. */
  readonly searchOpen: boolean;
  readonly searchTab: SearchTab;
  /** Counts how many times the box of the Search panel was asked for, so a key pressed while the panel is open focuses the box again. */
  readonly searchFocus: number;
  /** Whether the sheet of keyboard shortcuts is shown. */
  readonly sheetOpen: boolean;
  /** The canvas's element walk is on: the keys move a ring through the drawn elements. Not saved with a view. */
  readonly walking: boolean;
  /** The element the walk is at, or was at when it ended, until it is gone; the ring is drawn only while the walk is on. */
  readonly focused: string | undefined;
  /** What the last arrow-key move did, for screen readers, until the walk moves, the selection changes or the canvas loses the focus. */
  readonly moveNote: { readonly text: string; readonly serial: number } | undefined;
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
  searchOpen: false,
  searchTab: 'canvas',
  searchFocus: 0,
  sheetOpen: false,
  walking: false,
  focused: undefined,
  moveNote: undefined,
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
  /** Stores the positions of several entities as one update; with `announcement` the update also carries what a screen reader is told, as a new announcement even when the text is the same as the last. */
  setPositions(positions: ReadonlyMap<string, Position>, announcement?: string): void;
  pin(keys: readonly string[]): void;
  setPanelSize(panel: string, size: number): void;
  clearPanelSize(panel: string): void;
  setLegendOpen(open: boolean): void;
  setSearchOpen(open: boolean): void;
  setSearchTab(tab: SearchTab): void;
  /** Opens the Search panel, or asks an open one to focus its box again. */
  requestSearch(): void;
  setSheetOpen(open: boolean): void;
  /** Sets or clears what the last arrow-key move did. */
  announceMove(text: string | undefined): void;
  /** Starts the walk at an element, or moves it to another. */
  walkTo(key: string): void;
  /** Ends the walk, remembering where it was. */
  endWalk(): void;
  /** Forgets the element the walk was at, and keeps the walk going from the canvas itself. */
  forgetFocused(): void;
  setPanelCollapsed(panel: string, registration: number, collapsed: boolean): void;
  /** Lets go of a panel's collapsed state when that registration is taken out; the state of a newer registration of the same ID stays. */
  clearPanelCollapsed(panel: string, registration: number): void;
  setViewport(viewport: Viewport): void;
}

export type PresentationSnapshot = Pick<PresentationState, 'selection' | 'positions' | 'pins' | 'viewport'>;

export interface PresentationStore extends PresentationActions {
  reset(): void;
  snapshot(): PresentationSnapshot;
  restore(snapshot: PresentationSnapshot): void;
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
      store.setState({ ...store.getState(), selection: new Set(keys), moveNote: undefined });
    },
    setPosition(key, position) {
      requireKnown([key], known.isNode);
      store.setState({ ...store.getState(), positions: new Map(store.getState().positions).set(key, position) });
    },
    setPositions(positions, announcement) {
      requireKnown([...positions.keys()], known.isNode);
      const current = store.getState();
      store.setState({ ...current, positions: new Map([...current.positions, ...positions]), ...(announcement === undefined ? {} : { moveNote: { text: announcement, serial: (current.moveNote?.serial ?? 0) + 1 } }) });
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
    setSearchOpen(searchOpen) {
      if (store.getState().searchOpen === searchOpen) return;
      store.setState({ ...store.getState(), searchOpen });
    },
    setSearchTab(searchTab) {
      if (store.getState().searchTab === searchTab) return;
      store.setState({ ...store.getState(), searchTab });
    },
    requestSearch() {
      const current = store.getState();
      store.setState({ ...current, searchOpen: true, searchFocus: current.searchFocus + 1 });
    },
    setSheetOpen(sheetOpen) {
      if (store.getState().sheetOpen === sheetOpen) return;
      store.setState({ ...store.getState(), sheetOpen });
    },
    walkTo(key) {
      requireKnown([key], known.isElement);
      const current = store.getState();
      if (current.walking && current.focused === key) return;
      store.setState({ ...current, walking: true, focused: key, moveNote: undefined });
    },
    announceMove(text) {
      const current = store.getState();
      if (text === undefined && current.moveNote === undefined) return;
      store.setState({ ...current, moveNote: text === undefined ? undefined : { text, serial: (current.moveNote?.serial ?? 0) + 1 } });
    },
    endWalk() {
      if (!store.getState().walking) return;
      store.setState({ ...store.getState(), walking: false });
    },
    forgetFocused() {
      if (store.getState().focused === undefined) return;
      store.setState({ ...store.getState(), focused: undefined });
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
      const focused = current.focused !== undefined && known.isElement(current.focused) ? current.focused : undefined;
      if (selection.length === current.selection.size && positions.length === current.positions.size && pins.length === current.pins.size && focused === current.focused) return;
      store.setState({ ...current, selection: new Set(selection), positions: new Map(positions), pins: new Set(pins), focused });
    },
    snapshot() {
      const { selection, positions, pins, viewport } = store.getState();
      return { selection, positions, pins, viewport };
    },
    restore(snapshot) {
      store.setState({ ...store.getState(), ...snapshot, walking: false, focused: undefined, moveNote: undefined, openMenu: undefined });
    },
    reset() {
      const { tool, panelSizes, collapsedPanels, legendOpen, searchOpen, searchTab, searchFocus, sheetOpen } = store.getState();
      store.setState({ ...INITIAL_PRESENTATION, tool, panelSizes, collapsedPanels, legendOpen, searchOpen, searchTab, searchFocus, sheetOpen });
    },
  };
}
