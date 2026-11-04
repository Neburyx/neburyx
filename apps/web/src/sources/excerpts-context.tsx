import { createContext, useContext, type ReactNode } from 'react';
import { useStoreSelector } from '../state/store.js';
import type { Excerpt, Excerpts } from './excerpts.js';

const ExcerptsContext = createContext<Excerpts | undefined>(undefined);

export function ExcerptsProvider({ excerpts, children }: { readonly excerpts: Excerpts; readonly children: ReactNode }) {
  return <ExcerptsContext.Provider value={excerpts}>{children}</ExcerptsContext.Provider>;
}

export function useExcerpts(): Excerpts {
  const excerpts = useContext(ExcerptsContext);
  if (excerpts === undefined) throw new Error('the excerpts are not provided');
  return excerpts;
}

export function useExcerpt(sourceId: string): Excerpt | undefined {
  return useStoreSelector(useExcerpts(), (state) => state.get(sourceId));
}
