import type { ComponentType } from 'react';
import type { EdgeRef } from '@neburyx/contracts';
import { useClientState, useSessionMask } from '../state/context.js';
import type { ClientState } from '../state/client-state.js';
import { edgeKey } from '../state/keys.js';
import { partitionEdges } from '../state/loaded-graph.js';
import { useStoreSelector } from '../state/store.js';
import type { PanelRegistry } from '../workspace/panel-registry.js';
import { EVIDENCE_PANEL_TITLE } from './copy.js';
import type { Evidence } from './evidence.js';
import { EvidencePanelView } from './evidence-panel.js';

export const EVIDENCE_PANEL_ID = 'evidence';

const epochOf = (state: ClientState): string => JSON.stringify([state.investigation.getState().id, state.mask.getState()]);

/** The one drawn relationship the selection holds, when it is the only selected element. */
function selectedEdgeOf(state: ClientState): EdgeRef | undefined {
  const { selection } = state.presentation.view.getState();
  if (selection.size !== 1) return undefined;
  const [key] = selection;
  return partitionEdges(state.visibleGraph()).drawable.find((edge) => edgeKey(edge.ref) === key)?.ref;
}

function EvidenceDock({ evidence }: { readonly evidence: Evidence }) {
  const state = useClientState();
  const mask = useSessionMask();
  const edge = useStoreSelector(evidence.target, (current) => current);
  const choice = useStoreSelector(evidence.choices, (current) => current);
  const selection = useStoreSelector(state.presentation.view, (current) => current.selection);
  if (edge === undefined) return null;
  return <EvidencePanelView edge={edge} kinds={evidence.kinds} mask={mask} selected={selection.size === 1 && selection.has(edgeKey(edge))} choice={choice} onClose={evidence.close} />;
}

/**
 * Keeps the evidence panel in the dock exactly while a relationship is the target, and moves the target to the single selected relationship that a kind builds the evidence of. A change of investigation or of masking closes it.
 * It lives outside React, so leaving the page keeps nothing behind.
 */
export function bindEvidencePanel(state: ClientState, panels: PanelRegistry, evidence: Evidence): () => void {
  let remove: (() => void) | undefined;
  let epoch = epochOf(state);
  let lastSelection = state.presentation.view.getState().selection;
  const Content: ComponentType = () => <EvidenceDock evidence={evidence} />;
  const sync = (): void => {
    const now = epochOf(state);
    if (now !== epoch) {
      epoch = now;
      if (evidence.target.getState() !== undefined) evidence.close();
    }
    const { selection } = state.presentation.view.getState();
    if (selection !== lastSelection) {
      lastSelection = selection;
      const followed = selectedEdgeOf(state);
      if (followed !== undefined) evidence.follow(followed);
    }
    const open = evidence.target.getState() !== undefined;
    if (open && remove === undefined) remove = panels.register({ id: EVIDENCE_PANEL_ID, title: EVIDENCE_PANEL_TITLE, placement: { kind: 'dock' }, content: Content });
    else if (!open && remove !== undefined) {
      remove();
      remove = undefined;
    }
  };
  const unsubscribes = [state.presentation.view.subscribe(sync), state.server.subscribe(sync), state.investigation.subscribe(sync), state.mask.subscribe(sync), evidence.target.subscribe(sync)];
  sync();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    remove?.();
    remove = undefined;
  };
}
