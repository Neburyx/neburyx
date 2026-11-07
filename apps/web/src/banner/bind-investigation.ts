import type { ClientState } from '../state/client-state.js';
import type { BannerController } from './banner-controller.js';

/** Empties the banner at the moment the open investigation or its source changes, not at the next render, so a banner shown right after the change stays and a Retry never sends a request of an investigation that is no longer open. */
export function bindBannerToInvestigation(state: ClientState, banner: BannerController): () => void {
  let held = state.investigation.getState();
  return state.investigation.subscribe(() => {
    const next = state.investigation.getState();
    const changed = next.id !== held.id || next.sourceId !== held.sourceId;
    held = next;
    if (changed) banner.clear();
  });
}
