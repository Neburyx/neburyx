import { DEFAULT_DIRECTION, DEFAULT_LAYOUT, type LayoutDirection, type LayoutId } from './layout-choice.js';
import { StateError } from './errors.js';
import { nodeRefOfKey } from './keys.js';
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
  /** IDs of items the menu leaves out, for a menu opened beside buttons that already do what those items do. */
  readonly leaveOut?: readonly string[];
}

/** A flyout is open for the registration of a tool, so a tool taken out and registered again does not bring back a flyout that was open before. */
export interface OpenTool {
  readonly id: string;
  readonly registration: number;
}

export type SearchTab = 'canvas' | 'source';

/** The types switched off in the Filters panel; a type that is not listed is on, so a type that first appears later is shown. */
export interface TypeFilter {
  readonly offEntityTypes: ReadonlySet<string>;
  readonly offRelationshipTypes: ReadonlySet<string>;
}

export const NO_TYPE_FILTER: TypeFilter = { offEntityTypes: new Set(), offRelationshipTypes: new Set() };

/** The entity and relationship types the mapping of the bound source names; undefined until its profile is read. */
export interface MappedTypes {
  readonly entityTypes: readonly string[];
  readonly relationshipTypes: readonly string[];
}

export interface PresentationState {
  readonly tool: PointerTool;
  /** How the loaded graph is arranged when a person lays it out, and which way a hierarchical layout runs. Part of the view that is saved. */
  readonly layout: LayoutId;
  readonly layoutDirection: LayoutDirection;
  /** Whether the force layout keeps running, so that a dragged entity pulls its neighbors. Part of the view that is saved. */
  readonly physics: boolean;
  readonly selection: ReadonlySet<string>;
  readonly positions: ReadonlyMap<string, Position>;
  readonly pins: ReadonlySet<string>;
  /** The keys of the entities hidden from the view: still loaded, not drawn. Part of the view that is saved. */
  readonly hidden: ReadonlySet<string>;
  /** The key of the entity the neighborhood focus is on: only it and its loaded neighbors are drawn. Session state: kept when an investigation is set aside and resumed, and not part of a saved view. */
  readonly neighborhoodFocus: string | undefined;
  /** The viewport from before the first entry into focus, put back when focus ends; present exactly while focus is on. */
  readonly focusReturn: { readonly viewport: Viewport | undefined } | undefined;
  /** What the canvas is asked to do with its view after the next drawing: fit it to what is drawn (focus was put on an entity), or show the viewport from before focus. A new object for each request, so each is served once. Not saved with a view. */
  readonly viewChange: ViewChange | undefined;
  /** The types the Filters panel has switched off: still loaded, not drawn. Part of the view that is saved. */
  readonly typeFilter: TypeFilter;
  /** The types of the mapping, which a type to switch off must be one of. Not saved with a view. */
  readonly mappedTypes: MappedTypes | undefined;
  /** The Filters panel is open; it and the Search panel are never open together. Not saved with a view, and kept when another source is bound. */
  readonly filtersOpen: boolean;
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
  /** The keys of the items the scene draws that are not loaded elements (aggregate nodes), in walk order: the walk may stand on them, and select, position and pin still refuse them. */
  readonly sceneItems: readonly string[];
  /** The key of the node the Expand relationships panel is open for, and the neighbor type to have ticked when it was opened from an aggregate node; undefined when the panel is closed. Not saved with a view. */
  readonly supernodePanel: { readonly key: string; readonly neighborType?: string | undefined } | undefined;
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

export interface ViewChange {
  readonly show: 'fit' | { readonly viewport: Viewport | undefined };
}

/** What a screen reader is told when focus ends. */
export const FOCUS_LEFT = 'Focus left.';

/** The fields that end the focus: the viewport from before it comes back, and the canvas is asked to show it. */
function endedFocus(current: PresentationState): Pick<PresentationState, 'neighborhoodFocus' | 'focusReturn' | 'viewport' | 'viewChange'> {
  const held = current.focusReturn?.viewport;
  return { neighborhoodFocus: undefined, focusReturn: undefined, viewport: held, viewChange: { show: { viewport: held } } };
}

export const INITIAL_PRESENTATION: PresentationState = {
  tool: 'select',
  layout: DEFAULT_LAYOUT,
  layoutDirection: DEFAULT_DIRECTION,
  physics: false,
  selection: new Set(),
  positions: new Map(),
  pins: new Set(),
  hidden: new Set(),
  neighborhoodFocus: undefined,
  focusReturn: undefined,
  viewChange: undefined,
  typeFilter: NO_TYPE_FILTER,
  mappedTypes: undefined,
  filtersOpen: false,
  panelSizes: new Map(),
  collapsedPanels: new Map(),
  legendOpen: false,
  searchOpen: false,
  searchTab: 'canvas',
  searchFocus: 0,
  sheetOpen: false,
  sceneItems: [],
  supernodePanel: undefined,
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
  setLayout(layout: LayoutId): void;
  setLayoutDirection(direction: LayoutDirection): void;
  setPhysics(on: boolean): void;
  setPosition(key: string, position: Position): void;
  /** Stores the positions a layout run gave and asks the canvas to fit the view to what is drawn once they are drawn. */
  applyLayout(positions: ReadonlyMap<string, Position>): void;
  /** Stores the positions of several entities as one update; with `announcement` the update also carries what a screen reader is told, as a new announcement even when the text is the same as the last. */
  setPositions(positions: ReadonlyMap<string, Position>, announcement?: string): void;
  pin(keys: readonly string[]): void;
  /** Releases the named pins; keys that are not pinned are ignored. */
  unpin(keys: readonly string[]): void;
  /** Hides entities (refused for a key that is not a loaded entity), and takes them, and the keys in `alsoDeselect` (the relationships that touch them), out of the selection; the walk forgets a focus on them and a panel or menu about one closes. */
  hide(keys: readonly string[], alsoDeselect?: readonly string[]): void;
  /** Puts the focus on an entity (refused for a key that is not a loaded entity, or is hidden). `gone` holds the keys the focus sets aside (entities and the relationships that touch them): they leave the selection, the walk forgets one, and a menu or panel about one closes. The viewport from before the first entry is held: `viewport` when given (what the canvas shows), otherwise the one the store holds. */
  focusOn(key: string, gone: readonly string[], viewport?: Viewport): void;
  /** Ends the focus and puts back the viewport from before it was first set. */
  leaveFocus(): void;
  /** Shows the named hidden entities again, and no others. */
  showHidden(keys: readonly string[]): void;
  /** Shows every hidden entity again. */
  showAllHidden(): void;
  /** Tells which types the mapping names; an off type a known mapping does not name is dropped from the filter. Undefined when no profile is known: the filter is kept as it is. */
  setMappedTypes(types: MappedTypes | undefined): void;
  /** Switches every type on again. */
  resetTypeFilter(): void;
  setFiltersOpen(open: boolean): void;
  setPanelSize(panel: string, size: number): void;
  clearPanelSize(panel: string): void;
  setLegendOpen(open: boolean): void;
  setSearchOpen(open: boolean): void;
  setSearchTab(tab: SearchTab): void;
  /** Opens the Search panel, or asks an open one to focus its box again. */
  requestSearch(): void;
  setSheetOpen(open: boolean): void;
  /** Tells which scene items are drawn, in walk order; a walk standing on one that is gone is forgotten by the canvas. */
  setSceneItems(keys: readonly string[]): void;
  /** Opens the Expand relationships panel for a node of the investigation (refused for a key it does not hold), or closes it with none. */
  setSupernodePanel(open: { readonly key: string; readonly neighborType?: string | undefined } | undefined): void;
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

export type PresentationSnapshot = Pick<PresentationState, 'layout' | 'layoutDirection' | 'physics' | 'selection' | 'positions' | 'pins' | 'hidden' | 'typeFilter' | 'neighborhoodFocus' | 'focusReturn' | 'viewport'>;

export interface PresentationStore extends PresentationActions {
  reset(): void;
  snapshot(): PresentationSnapshot;
  restore(snapshot: PresentationSnapshot): void;
  replacePins(keys: readonly string[]): void;
  /** Switches an entity type of the mapping off or on (refused with `UNKNOWN_TYPE` for another); the entities of an off type, and the keys in `alsoDeselect` (the relationships that touch them), leave the selection, and the walk, the Expand panel and a menu about one let go of it. */
  setEntityTypeOff(type: string, off: boolean, alsoDeselect?: readonly string[]): void;
  /** Switches a relationship type of the mapping off or on (refused with `UNKNOWN_TYPE` for another); `leaving` are the keys of the loaded relationships of that type, which leave the selection, and a walk or a menu on one lets go of it. */
  setRelationshipTypeOff(type: string, off: boolean, leaving?: readonly string[]): void;
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
    setLayout(layout) {
      store.setState({ ...store.getState(), layout });
    },
    setLayoutDirection(direction) {
      store.setState({ ...store.getState(), layoutDirection: direction });
    },
    setPhysics(on) {
      store.setState({ ...store.getState(), physics: on });
    },
    applyLayout(positions) {
      requireKnown([...positions.keys()], known.isNode);
      const current = store.getState();
      store.setState({ ...current, positions: positions.size === 0 ? current.positions : new Map([...current.positions, ...positions]), viewChange: { show: 'fit' } });
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
    unpin(keys) {
      const { pins } = store.getState();
      const released = keys.filter((key) => pins.has(key));
      if (released.length === 0) return;
      store.setState({ ...store.getState(), pins: new Set([...pins].filter((key) => !released.includes(key))) });
    },
    hide(keys, alsoDeselect = []) {
      requireKnown(keys, known.isNode);
      const current = store.getState();
      const gone = new Set([...keys, ...alsoDeselect]);
      const focusGone = current.focused !== undefined && gone.has(current.focused);
      const endsFocus = current.neighborhoodFocus !== undefined && gone.has(current.neighborhoodFocus);
      store.setState({
        ...current,
        ...(endsFocus ? endedFocus(current) : {}),
        hidden: new Set([...current.hidden, ...keys]),
        selection: new Set([...current.selection].filter((key) => !gone.has(key))),
        focused: focusGone ? undefined : current.focused,
        supernodePanel: current.supernodePanel !== undefined && gone.has(current.supernodePanel.key) ? undefined : current.supernodePanel,
        openMenu: current.openMenu?.key !== undefined && gone.has(current.openMenu.key) ? undefined : current.openMenu,
        moveNote: undefined,
      });
    },
    focusOn(key, gone, shown) {
      requireKnown([key], known.isNode);
      const current = store.getState();
      if (current.hidden.has(key)) throw new StateError('UNKNOWN_ELEMENT');
      const leaving = new Set(gone);
      store.setState({
        ...current,
        neighborhoodFocus: key,
        focusReturn: current.focusReturn ?? { viewport: shown ?? current.viewport },
        viewChange: { show: 'fit' },
        selection: new Set([...current.selection].filter((candidate) => !leaving.has(candidate))),
        focused: current.focused !== undefined && leaving.has(current.focused) ? undefined : current.focused,
        supernodePanel: current.supernodePanel !== undefined && leaving.has(current.supernodePanel.key) ? undefined : current.supernodePanel,
        openMenu: current.openMenu?.key !== undefined && leaving.has(current.openMenu.key) ? undefined : current.openMenu,
        moveNote: undefined,
      });
    },
    leaveFocus() {
      const current = store.getState();
      if (current.neighborhoodFocus === undefined) return;
      store.setState({ ...current, ...endedFocus(current) });
    },
    showHidden(keys) {
      const current = store.getState();
      if (!keys.some((key) => current.hidden.has(key))) return;
      store.setState({ ...current, hidden: new Set([...current.hidden].filter((key) => !keys.includes(key))) });
    },
    showAllHidden() {
      if (store.getState().hidden.size === 0) return;
      store.setState({ ...store.getState(), hidden: new Set() });
    },
    setEntityTypeOff(type, off, alsoDeselect = []) {
      const current = store.getState();
      if (current.mappedTypes === undefined || !current.mappedTypes.entityTypes.includes(type)) throw new StateError('UNKNOWN_TYPE');
      if (current.typeFilter.offEntityTypes.has(type) === off) return;
      const offEntityTypes = new Set(current.typeFilter.offEntityTypes);
      if (off) offEntityTypes.add(type);
      else offEntityTypes.delete(type);
      const typeFilter = { ...current.typeFilter, offEntityTypes };
      if (!off) {
        store.setState({ ...current, typeFilter });
        return;
      }
      const gone = (key: string): boolean => nodeRefOfKey(key)?.entityType === type || alsoDeselect.includes(key);
      const endsFocus = current.neighborhoodFocus !== undefined && gone(current.neighborhoodFocus);
      store.setState({
        ...current,
        ...(endsFocus ? endedFocus(current) : {}),
        typeFilter,
        selection: new Set([...current.selection].filter((key) => !gone(key))),
        focused: current.focused !== undefined && gone(current.focused) ? undefined : current.focused,
        supernodePanel: current.supernodePanel !== undefined && gone(current.supernodePanel.key) ? undefined : current.supernodePanel,
        openMenu: current.openMenu?.key !== undefined && gone(current.openMenu.key) ? undefined : current.openMenu,
        moveNote: endsFocus ? { text: FOCUS_LEFT, serial: (current.moveNote?.serial ?? 0) + 1 } : undefined,
      });
    },
    setRelationshipTypeOff(type, off, leaving = []) {
      const current = store.getState();
      if (current.mappedTypes === undefined || !current.mappedTypes.relationshipTypes.includes(type)) throw new StateError('UNKNOWN_TYPE');
      if (current.typeFilter.offRelationshipTypes.has(type) === off) return;
      const offRelationshipTypes = new Set(current.typeFilter.offRelationshipTypes);
      if (off) offRelationshipTypes.add(type);
      else offRelationshipTypes.delete(type);
      const typeFilter = { ...current.typeFilter, offRelationshipTypes };
      if (!off) {
        store.setState({ ...current, typeFilter });
        return;
      }
      const gone = new Set(leaving);
      store.setState({
        ...current,
        typeFilter,
        selection: new Set([...current.selection].filter((key) => !gone.has(key))),
        focused: current.focused !== undefined && gone.has(current.focused) ? undefined : current.focused,
        openMenu: current.openMenu?.key !== undefined && gone.has(current.openMenu.key) ? undefined : current.openMenu,
        moveNote: undefined,
      });
    },
    setMappedTypes(mappedTypes) {
      const current = store.getState();
      const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, at) => item === b[at]);
      if (current.mappedTypes === mappedTypes || (current.mappedTypes !== undefined && mappedTypes !== undefined && same(current.mappedTypes.entityTypes, mappedTypes.entityTypes) && same(current.mappedTypes.relationshipTypes, mappedTypes.relationshipTypes))) return;
      if (mappedTypes === undefined) {
        store.setState({ ...current, mappedTypes });
        return;
      }
      const offEntityTypes = new Set([...current.typeFilter.offEntityTypes].filter((type) => mappedTypes.entityTypes.includes(type)));
      const offRelationshipTypes = new Set([...current.typeFilter.offRelationshipTypes].filter((type) => mappedTypes.relationshipTypes.includes(type)));
      const kept = offEntityTypes.size === current.typeFilter.offEntityTypes.size && offRelationshipTypes.size === current.typeFilter.offRelationshipTypes.size;
      store.setState({ ...current, mappedTypes, typeFilter: kept ? current.typeFilter : { offEntityTypes, offRelationshipTypes } });
    },
    resetTypeFilter() {
      const { typeFilter } = store.getState();
      if (typeFilter.offEntityTypes.size === 0 && typeFilter.offRelationshipTypes.size === 0) return;
      store.setState({ ...store.getState(), typeFilter: NO_TYPE_FILTER });
    },
    setFiltersOpen(filtersOpen) {
      if (store.getState().filtersOpen === filtersOpen) return;
      store.setState({ ...store.getState(), filtersOpen, ...(filtersOpen ? { searchOpen: false } : {}) });
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
      store.setState({ ...store.getState(), searchOpen, ...(searchOpen ? { filtersOpen: false } : {}) });
    },
    setSearchTab(searchTab) {
      if (store.getState().searchTab === searchTab) return;
      store.setState({ ...store.getState(), searchTab });
    },
    requestSearch() {
      const current = store.getState();
      store.setState({ ...current, searchOpen: true, filtersOpen: false, searchFocus: current.searchFocus + 1 });
    },
    setSheetOpen(sheetOpen) {
      if (store.getState().sheetOpen === sheetOpen) return;
      store.setState({ ...store.getState(), sheetOpen });
    },
    walkTo(key) {
      requireKnown([key], (candidate) => known.isElement(candidate) || store.getState().sceneItems.includes(candidate));
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
    setSceneItems(keys) {
      const held = store.getState().sceneItems;
      if (held.length === keys.length && held.every((key, at) => key === keys[at])) return;
      store.setState({ ...store.getState(), sceneItems: keys });
    },
    setSupernodePanel(open) {
      if (open !== undefined) requireKnown([open.key], known.isNode);
      store.setState({ ...store.getState(), supernodePanel: open });
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
      const hidden = [...current.hidden].filter(known.isNode);
      const focused = current.focused !== undefined && (known.isElement(current.focused) || current.sceneItems.includes(current.focused)) ? current.focused : undefined;
      const supernodePanel = current.supernodePanel !== undefined && known.isNode(current.supernodePanel.key) ? current.supernodePanel : undefined;
      const focusLost = current.neighborhoodFocus !== undefined && !known.isNode(current.neighborhoodFocus);
      if (!focusLost && selection.length === current.selection.size && positions.length === current.positions.size && pins.length === current.pins.size && hidden.length === current.hidden.size && focused === current.focused && supernodePanel === current.supernodePanel) return;
      store.setState({
        ...current,
        ...(focusLost ? { ...endedFocus(current), moveNote: { text: FOCUS_LEFT, serial: (current.moveNote?.serial ?? 0) + 1 } } : {}),
        selection: new Set(selection),
        positions: new Map(positions),
        pins: new Set(pins),
        hidden: new Set(hidden),
        focused,
        supernodePanel,
      });
    },
    snapshot() {
      const { layout, layoutDirection, physics, selection, positions, pins, hidden, typeFilter, neighborhoodFocus, focusReturn, viewport } = store.getState();
      return { layout, layoutDirection, physics, selection, positions, pins, hidden, typeFilter, neighborhoodFocus, focusReturn, viewport };
    },
    restore(snapshot) {
      store.setState({ ...store.getState(), ...snapshot, walking: false, focused: undefined, moveNote: undefined, openMenu: undefined });
    },
    reset() {
      const { tool, panelSizes, collapsedPanels, legendOpen, searchOpen, searchTab, searchFocus, sheetOpen, filtersOpen, mappedTypes } = store.getState();
      store.setState({ ...INITIAL_PRESENTATION, tool, panelSizes, collapsedPanels, legendOpen, searchOpen, searchTab, searchFocus, sheetOpen, filtersOpen, mappedTypes });
    },
  };
}
