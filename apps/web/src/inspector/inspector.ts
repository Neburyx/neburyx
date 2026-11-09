import { createStore, readable, type ReadableStore } from '../state/store.js';
import { createContext, useContext } from 'react';
import { createInspectorTabRegistry, createNeighborRowRegistry, type InspectorTabRegistry, type NeighborRowRegistry } from './inspector-tabs.js';

export interface Inspector {
  readonly tabs: InspectorTabRegistry;
  /** Rows a later feature adds to the Overview's sourced neighbors section. */
  readonly neighborRows: NeighborRowRegistry;
  /** The entity whose inspector the person closed; it stays closed until the selection changes to another single entity. */
  readonly dismissed: ReadableStore<string | undefined>;
  dismiss(key: string): void;
  clearDismissal(): void;
}

export function createInspector(): Inspector {
  const dismissed = createStore<string | undefined>(undefined);
  return {
    tabs: createInspectorTabRegistry(),
    neighborRows: createNeighborRowRegistry(),
    dismissed: readable(dismissed),
    dismiss: (key) => dismissed.setState(key),
    clearDismissal: () => dismissed.setState(undefined),
  };
}

export const InspectorContext = createContext<Inspector | undefined>(undefined);

export function useInspector(): Inspector {
  const inspector = useContext(InspectorContext);
  if (inspector === undefined) throw new Error('the inspector is not provided');
  return inspector;
}
