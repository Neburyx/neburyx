import { createContext, useContext, type ReactNode } from 'react';
import type { PreviewStore } from '../api/preview-store.js';
import { createStore, readable, useStoreSelector, type ReadableStore } from '../state/store.js';

const NO_ANSWERS: ReadableStore<number> = readable(createStore(0));

const PreviewContext = createContext<PreviewStore | undefined>(undefined);

export function PreviewProvider({ store, children }: { readonly store: PreviewStore; readonly children: ReactNode }) {
  return <PreviewContext.Provider value={store}>{children}</PreviewContext.Provider>;
}

export function usePreviewStore(): PreviewStore {
  const store = useContext(PreviewContext);
  if (store === undefined) throw new Error('the degree previews are not provided');
  return store;
}

/** The store when one is provided, and nothing in a part of the app drawn without previews. */
export function usePreviewStoreWhenProvided(): PreviewStore | undefined {
  return useContext(PreviewContext);
}

/** How many previews have been answered; 0 in a part of the app drawn without previews. */
export function usePreviewAnswers(): number {
  return useStoreSelector(useContext(PreviewContext)?.answers ?? NO_ANSWERS, (answers) => answers);
}
