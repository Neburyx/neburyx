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

export interface PresentationState {
  readonly tool: PointerTool;
  readonly selection: ReadonlySet<string>;
  readonly positions: ReadonlyMap<string, Position>;
  readonly pins: ReadonlySet<string>;
  readonly panelSizes: ReadonlyMap<string, number>;
  /** Undefined until a view was set, so that a view that was never set differs from a stored one at zoom 1. */
  readonly viewport: Viewport | undefined;
}

export const INITIAL_PRESENTATION: PresentationState = {
  tool: 'select',
  selection: new Set(),
  positions: new Map(),
  pins: new Set(),
  panelSizes: new Map(),
  viewport: undefined,
};

/** What the investigation holds: a node key, or a node or relationship key. */
export interface KnownElements {
  readonly isNode: (key: string) => boolean;
  readonly isElement: (key: string) => boolean;
}

export interface PresentationActions {
  readonly view: ReadableStore<PresentationState>;
  setTool(tool: PointerTool): void;
  select(keys: readonly string[]): void;
  setPosition(key: string, position: Position): void;
  pin(keys: readonly string[]): void;
  setPanelSize(panel: string, size: number): void;
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
    select(keys) {
      requireKnown(keys, known.isElement);
      store.setState({ ...store.getState(), selection: new Set(keys) });
    },
    setPosition(key, position) {
      requireKnown([key], known.isNode);
      store.setState({ ...store.getState(), positions: new Map(store.getState().positions).set(key, position) });
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
      store.setState({ ...store.getState(), panelSizes: new Map(store.getState().panelSizes).set(panel, size) });
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
      store.setState({ ...INITIAL_PRESENTATION, tool: store.getState().tool });
    },
  };
}
