import { createContext, useContext, type ReactNode } from 'react';
import type { DerivedStore } from '../api/derived-store.js';

const DerivedContext = createContext<DerivedStore | undefined>(undefined);

export function DerivedProvider({ store, children }: { readonly store: DerivedStore; readonly children: ReactNode }) {
  return <DerivedContext.Provider value={store}>{children}</DerivedContext.Provider>;
}

/** The store when one is provided, and nothing in a part of the app drawn without derived neighbors. */
export function useDerivedStoreWhenProvided(): DerivedStore | undefined {
  return useContext(DerivedContext);
}
