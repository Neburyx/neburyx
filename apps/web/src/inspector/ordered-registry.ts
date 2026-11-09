import { createStore, readable, useStoreSelector, type ReadableStore } from '../state/store.js';

export interface Ordered {
  readonly id: string;
  /** Where the entry stands, lowest first. */
  readonly order: number;
}

export class RegistryError extends Error {
  readonly code = 'ENTRY_TAKEN';

  constructor(readonly entryId: string) {
    super(`ENTRY_TAKEN: ${entryId}`);
    this.name = 'RegistryError';
  }
}

export interface OrderedRegistry<T extends Ordered> {
  readonly view: ReadableStore<readonly T[]>;
  /** Adds an entry and returns the function that takes out that registration only. An ID already registered is refused. */
  register(entry: T): () => void;
}

export function createOrderedRegistry<T extends Ordered>(): OrderedRegistry<T> {
  const store = createStore<readonly T[]>([]);
  const registrations: Array<{ readonly token: symbol; readonly entry: T }> = [];
  const publish = (): void => store.setState(registrations.map(({ entry }) => entry).sort((a, b) => a.order - b.order));
  return {
    view: readable(store),
    register(entry) {
      if (registrations.some((registration) => registration.entry.id === entry.id)) throw new RegistryError(entry.id);
      const token = Symbol(entry.id);
      registrations.push({ token, entry });
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

export const useOrdered = <T extends Ordered>(registry: OrderedRegistry<T>): readonly T[] => useStoreSelector(registry.view, (entries) => entries);
