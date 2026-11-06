import { createContext, useContext, type ReactNode } from 'react';
import { useStoreSelector } from '../state/store.js';
import type { RecentInvestigations, RecentState } from './recent-store.js';

const RecentContext = createContext<RecentInvestigations | undefined>(undefined);

export function RecentProvider({ recent, children }: { readonly recent: RecentInvestigations; readonly children: ReactNode }) {
  return <RecentContext.Provider value={recent}>{children}</RecentContext.Provider>;
}

export function useRecent(): RecentInvestigations {
  const recent = useContext(RecentContext);
  if (recent === undefined) throw new Error('the recent investigations are not provided');
  return recent;
}

export function useRecentState(): RecentState {
  return useStoreSelector(useRecent(), (state) => state);
}
