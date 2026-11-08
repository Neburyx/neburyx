import { useEffect } from 'react';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { useClientState } from '../state/context.js';

/** Tells the state which types the mapping of the bound source names, so a filter can only name one of them. Draws nothing. */
export function MappedTypesSync() {
  const state = useClientState();
  const profile = useProfileWhenProvided();
  useEffect(() => {
    state.presentation.setMappedTypes(profile === undefined ? undefined : { entityTypes: profile.entityTypes.map((type) => type.type), relationshipTypes: [...new Set(profile.relationshipTypes.map((type) => type.type))] });
  }, [state, profile]);
  return null;
}
