import { createContext, useContext, type ReactNode } from 'react';
import type { SourceProfile } from '@neburyx/contracts';
import { useClientState } from '../state/context.js';
import { useStoreSelector, type ReadableStore } from '../state/store.js';
import { answeredData } from '../shell/shell-data.js';
import type { ProfileState, ProfileStore } from './profile-store.js';

const ProfileContext = createContext<ProfileStore | undefined>(undefined);

export function ProfileProvider({ store, children }: { readonly store: ProfileStore; readonly children: ReactNode }) {
  return <ProfileContext.Provider value={store}>{children}</ProfileContext.Provider>;
}

function useProfileStore(): ReadableStore<ProfileState> {
  const store = useContext(ProfileContext);
  if (store === undefined) throw new Error('the profile is not provided');
  return store;
}

export function useProfileState(): ProfileState {
  return useStoreSelector(useProfileStore(), (state) => state);
}

/** The profile of the bound source once it has been read; undefined while it is not yet known, and never the profile of another source. */
export function useProfile(): SourceProfile | undefined {
  const state = useProfileState();
  const bound = useStoreSelector(useClientState().investigation, (investigation) => investigation.sourceId);
  return state.sourceId === bound ? answeredData(state.request) : undefined;
}
