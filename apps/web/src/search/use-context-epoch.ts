import { useEffect, useState } from 'react';
import type { ClientState } from '../state/client-state.js';

/** Counts the changes as they happen and not as they render, so a change away and back inside one batch of updates still counts. */
export function useContextEpoch(state: ClientState): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const read = (): string => {
      const { id, sourceId } = state.investigation.getState();
      return `${id ?? ''}\u0000${sourceId ?? ''}\u0000${state.mask.getState()}`;
    };
    let last = read();
    const check = (): void => {
      const now = read();
      if (now === last) return;
      last = now;
      setEpoch((count) => count + 1);
    };
    const stopInvestigation = state.investigation.subscribe(check);
    const stopMask = state.mask.subscribe(check);
    return () => {
      stopInvestigation();
      stopMask();
    };
  }, [state]);
  return epoch;
}
