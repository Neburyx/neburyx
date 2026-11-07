import type { StoredEdgeRef } from '@neburyx/contracts';
import { createStore, readable, useStoreSelector } from '../state/store.js';

/** What opens the evidence of a relationship: the evidence panel registers it, and until it does a row has no **View evidence** action. */
export type ViewEvidence = (supports: StoredEdgeRef) => void;

interface Registration {
  readonly action: ViewEvidence;
}

const registered = createStore<Registration | undefined>(undefined);

/** Registers the action and returns what removes it; a later registration replaces an earlier one, and removing the earlier one leaves the later one in place, also when both are one function. */
export function registerViewEvidence(action: ViewEvidence): () => void {
  const registration: Registration = { action };
  registered.setState(registration);
  return () => {
    if (registered.getState() === registration) registered.setState(undefined);
  };
}

export const useViewEvidence = (): ViewEvidence | undefined => useStoreSelector(readable(registered), (registration) => registration?.action);
