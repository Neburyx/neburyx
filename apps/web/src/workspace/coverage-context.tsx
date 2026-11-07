import { createContext, useContext, type ReactNode } from 'react';
import type { CoverageStore } from '../api/coverage-store.js';

const CoverageContext = createContext<CoverageStore | undefined>(undefined);

export function CoverageProvider({ store, children }: { readonly store: CoverageStore; readonly children: ReactNode }) {
  return <CoverageContext.Provider value={store}>{children}</CoverageContext.Provider>;
}

/** The store when one is provided, and nothing in a part of the app drawn without coverage. */
export function useCoverageStoreWhenProvided(): CoverageStore | undefined {
  return useContext(CoverageContext);
}
