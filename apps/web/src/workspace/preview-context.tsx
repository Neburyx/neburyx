import { createContext, useContext, type ReactNode } from 'react';
import type { PreviewStore } from '../api/preview-store.js';

const PreviewContext = createContext<PreviewStore | undefined>(undefined);

export function PreviewProvider({ store, children }: { readonly store: PreviewStore; readonly children: ReactNode }) {
  return <PreviewContext.Provider value={store}>{children}</PreviewContext.Provider>;
}

export function usePreviewStore(): PreviewStore {
  const store = useContext(PreviewContext);
  if (store === undefined) throw new Error('the degree previews are not provided');
  return store;
}
