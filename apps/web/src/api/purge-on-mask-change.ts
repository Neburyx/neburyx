import type { ClientState } from '../state/client-state.js';

export interface Purgeable {
  clear(): void;
}

/** Drops what the session's stores hold when the masking setting changes: what was read with the other setting must not stay in memory, and what a consumer asks for next is read with the new one. */
export function purgeOnMaskChange(state: ClientState, stores: readonly Purgeable[]): () => void {
  let held = state.mask.getState();
  return state.mask.subscribe(() => {
    const now = state.mask.getState();
    if (now === held) return;
    held = now;
    for (const store of stores) store.clear();
  });
}
