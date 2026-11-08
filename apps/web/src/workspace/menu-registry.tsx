import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import type { CanvasCommands } from '../canvas/canvas-commands.js';
import type { ClientState } from '../state/client-state.js';
import type { MenuTargetKind } from '../state/presentation-state.js';
import type { ExpansionControls } from './expand-context.js';
import { createStore, readable, useStoreSelector, type ReadableStore } from '../state/store.js';

export type { MenuTargetKind };

/** The groups and orders of the items the design draws, so an item lands in its place whichever feature registers it first. */
export const MENU_GROUP = {
  canvas: { view: 10, grouping: 20, layoutAndLegend: 30, export: 40 },
  node: { expand: 10, paths: 20, selection: 30, copy: 40 },
  relationship: { explain: 10, endpoints: 20, visibility: 30, copy: 40 },
} as const;

export const MENU_ORDER = {
  canvas: { fit: 10, selectAll: 20, invertSelection: 30, groupAll: 10, ungroupAll: 20, layout: 10, showLegend: 20, exportView: 10 },
  node: {
    expandNeighbors: 10,
    expandByNeighborType: 20,
    expandByType: 25,
    collapse: 27,
    focusNeighborhood: 30,
    findPathsFromHere: 10,
    findPathsTo: 20,
    runPattern: 30,
    selectNeighbors: 10,
    invertSelection: 20,
    groupByType: 30,
    pinPosition: 40,
    hideFromView: 50,
    copyId: 10,
    copyProperties: 20,
    openSourceRecord: 30,
  },
  relationship: { explain: 10, viewSupportingRecords: 20, highlightEndpoints: 10, selectBothEndpoints: 20, findPathsBetween: 30, hideThis: 10, hideAllOfType: 20, showOnlyType: 30, copyRelationshipId: 10, copyProperties: 20, openSourceRecord: 30 },
} as const;

/** What an item's command is given when it runs: what the menu is about, the selection at that moment, and what a command needs to act. */
export interface MenuContext {
  readonly kind: MenuTargetKind;
  /** The key of the entity or relationship the menu is about; none for the canvas menu. */
  readonly key: string | undefined;
  readonly selection: readonly string[];
  readonly state: ClientState;
  /** Absent while no renderer is running. */
  readonly canvas: CanvasCommands | undefined;
  /** What expanding a node needs; absent where the app is drawn without expansions. */
  readonly expansion?: ExpansionControls | undefined;
}

export type MenuItemState = 'enabled' | 'disabled';

/** What a submenu's content is given: the menu context, and a function that closes the whole menu. */
export interface SubmenuProps {
  readonly context: MenuContext;
  readonly close: () => void;
}

export type MenuItemBehaviour =
  | { readonly run: (context: MenuContext) => void; readonly submenu?: never }
  /** An enabled item that opens this content beside its row; the feature that registers it draws it. */
  | { readonly submenu: ComponentType<SubmenuProps>; readonly run?: never };

export interface MenuItemShape {
  readonly id: string;
  readonly label: string | ((context: MenuContext) => string);
  readonly icon: ReactNode;
  readonly group: number;
  readonly order: number;
  /** The id of the registered key binding whose keys the row shows as its hint: the hint is the binding's, so it cannot name a key that does nothing. */
  readonly binding?: string;
  /** Enabled when not given; a function is asked each time the menu is drawn, with what the menu is about. A disabled item is shown, does nothing and never opens a submenu. */
  readonly state?: MenuItemState | ((context: MenuContext) => MenuItemState);
}

export type MenuItem = MenuItemShape & MenuItemBehaviour;

export function stateOf(item: MenuItemShape, context: MenuContext): MenuItemState {
  return typeof item.state === 'function' ? item.state(context) : (item.state ?? 'enabled');
}

export type RegisteredMenuItem = MenuItem & {
  readonly kind: MenuTargetKind;
  /** New each time an item is registered, also for an ID registered before. */
  readonly registration: number;
};

export class MenuItemError extends Error {
  readonly code = 'MENU_ITEM_TAKEN';

  constructor(
    readonly kind: MenuTargetKind,
    readonly itemId: string,
  ) {
    super(`MENU_ITEM_TAKEN: ${kind}/${itemId}`);
    this.name = 'MenuItemError';
  }
}

export type MenuItems = ReadonlyMap<MenuTargetKind, readonly RegisteredMenuItem[]>;

export interface MenuRegistry {
  readonly view: ReadableStore<MenuItems>;
  /** Adds an item to the menu of one kind and returns the function that takes out that registration only. An ID already registered for that kind is refused. */
  register(kind: MenuTargetKind, item: MenuItem): () => void;
}

export function createMenuRegistry(): MenuRegistry {
  const store = createStore<MenuItems>(new Map());
  const registrations: Array<{ readonly token: symbol; readonly item: RegisteredMenuItem }> = [];
  let registered = 0;
  const publish = (): void => {
    const lists = new Map<MenuTargetKind, RegisteredMenuItem[]>();
    for (const { item } of registrations) lists.set(item.kind, [...(lists.get(item.kind) ?? []), item]);
    for (const list of lists.values()) list.sort((a, b) => a.group - b.group || a.order - b.order || a.registration - b.registration);
    store.setState(lists);
  };
  return {
    view: readable(store),
    register(kind, item) {
      if (registrations.some((registration) => registration.item.kind === kind && registration.item.id === item.id)) throw new MenuItemError(kind, item.id);
      const token = Symbol(item.id);
      registered += 1;
      registrations.push({ token, item: { ...item, kind, registration: registered } });
      publish();
      return () => {
        const at = registrations.findIndex((registration) => registration.token === token);
        if (at === -1) return;
        registrations.splice(at, 1);
        publish();
      };
    },
  };
}

const MenuContextProvider = createContext<MenuRegistry | undefined>(undefined);

export function MenuProvider({ registry, children }: { readonly registry: MenuRegistry; readonly children: ReactNode }) {
  return <MenuContextProvider.Provider value={registry}>{children}</MenuContextProvider.Provider>;
}

export function useMenuRegistry(): MenuRegistry {
  const registry = useContext(MenuContextProvider);
  if (registry === undefined) throw new Error('the menus are not provided');
  return registry;
}

const NONE: readonly RegisteredMenuItem[] = [];

export function useMenuItems(kind: MenuTargetKind | undefined): readonly RegisteredMenuItem[] {
  return useStoreSelector(useMenuRegistry().view, (items) => (kind === undefined ? undefined : items.get(kind))) ?? NONE;
}
