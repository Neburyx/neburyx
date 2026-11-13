import { createContext, useContext } from 'react';
import type { Evidence } from '../evidence/evidence.js';

export const EvidenceHandleContext = createContext<Evidence | undefined>(undefined);

/** The relationship evidence of the workspace when the panel is bound with it, and nothing where it is not. */
export const useEvidenceHandle = (): Evidence | undefined => useContext(EvidenceHandleContext);
