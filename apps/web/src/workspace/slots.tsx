import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import { createStore, readable, useStoreSelector, type ReadableStore } from '../state/store.js';

export const SLOT_NAMES = ['investigation-menu', 'ask', 'summarize', 'views', 'export', 'save', 'tool-strip', 'toggles', 'table-toggle', 'zoom-controls', 'floating', 'search', 'settings'] as const;

export type SlotName = (typeof SLOT_NAMES)[number];

export class SlotError extends Error {
  readonly code = 'SLOT_TAKEN';

  constructor(readonly slot: SlotName) {
    super(`SLOT_TAKEN: ${slot}`);
    this.name = 'SlotError';
  }
}

export type SlotOccupants = ReadonlyMap<SlotName, ComponentType>;

export interface SlotRegistry {
  readonly view: ReadableStore<SlotOccupants>;
  /** Puts a component in a slot and returns the function that takes it out again. A taken slot is refused. */
  register(slot: SlotName, occupant: ComponentType): () => void;
}

export function createSlotRegistry(): SlotRegistry {
  const store = createStore<SlotOccupants>(new Map());
  const registrations = new Map<SlotName, symbol>();
  return {
    view: readable(store),
    register(slot, occupant) {
      const current = store.getState();
      if (current.has(slot)) throw new SlotError(slot);
      const registration = Symbol(slot);
      registrations.set(slot, registration);
      store.setState(new Map(current).set(slot, occupant));
      return () => {
        if (registrations.get(slot) !== registration) return;
        registrations.delete(slot);
        const next = new Map(store.getState());
        next.delete(slot);
        store.setState(next);
      };
    },
  };
}

const SlotsContext = createContext<SlotRegistry | undefined>(undefined);

export function SlotsProvider({ registry, children }: { readonly registry: SlotRegistry; readonly children: ReactNode }) {
  return <SlotsContext.Provider value={registry}>{children}</SlotsContext.Provider>;
}

export function useSlots(): SlotRegistry {
  const registry = useContext(SlotsContext);
  if (registry === undefined) throw new Error('the slots are not provided');
  return registry;
}

export function useOccupant(slot: SlotName): ComponentType | undefined {
  return useStoreSelector(useSlots().view, (occupants) => occupants.get(slot));
}

export function Slot({ name, fallback = null }: { readonly name: SlotName; readonly fallback?: ReactNode }) {
  const Occupant = useOccupant(name);
  return Occupant === undefined ? fallback : <Occupant />;
}
