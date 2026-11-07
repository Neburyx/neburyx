import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { SourceProfile } from '@neburyx/contracts';
import { useClientState } from '../state/context.js';
import { useStoreSelector, type ReadableStore } from '../state/store.js';
import { answeredData } from '../shell/shell-data.js';
import type { ProfileState, ProfileStore } from './profile-store.js';

const NO_SUBSCRIBE = (): (() => void) => () => undefined;
const NONE_STATE: ProfileState = { sourceId: null, request: { phase: 'idle' } };

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

/** The profile of the bound source when a profile is provided at all, and nothing when this part of the app is drawn without one (a surface that works without it). */
export function useProfileWhenProvided(): SourceProfile | undefined {
  const store = useContext(ProfileContext);
  const bound = useStoreSelector(useClientState().investigation, (investigation) => investigation.sourceId);
  const state = useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIBE, () => store?.getState() ?? NONE_STATE);
  return state.sourceId === bound ? answeredData(state.request) : undefined;
}
