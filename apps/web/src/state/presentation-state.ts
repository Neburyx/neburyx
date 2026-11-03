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

export interface PresentationState {
  readonly selection: ReadonlySet<string>;
  readonly positions: ReadonlyMap<string, Position>;
  readonly pins: ReadonlySet<string>;
  readonly panelSizes: ReadonlyMap<string, number>;
  readonly viewport: Viewport;
}

export const INITIAL_PRESENTATION: PresentationState = {
  selection: new Set(),
  positions: new Map(),
  pins: new Set(),
  panelSizes: new Map(),
  viewport: { zoom: 1, x: 0, y: 0 },
};

/** What the investigation holds: a node key, or a node or relationship key. */
export interface KnownElements {
  readonly isNode: (key: string) => boolean;
  readonly isElement: (key: string) => boolean;
}

export interface PresentationActions {
  readonly view: ReadableStore<PresentationState>;
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
      store.setState(INITIAL_PRESENTATION);
    },
  };
}
