import type { EdgeRef } from '@neburyx/contracts';
import type { Inspector } from '../inspector/inspector.js';
import type { ClientState } from '../state/client-state.js';
import { edgeKey } from '../state/keys.js';
import { partitionEdges } from '../state/loaded-graph.js';
import { MENU_GROUP, MENU_ORDER, type MenuContext, type MenuRegistry } from '../workspace/menu-registry.js';
import type { PanelRegistry } from '../workspace/panel-registry.js';
import { VIEW_SUPPORTING_RECORDS, WHY_HERE } from './copy.js';
import { bindEvidencePanel } from './evidence-binder.js';
import { evidenceTabFor } from './evidence-tab.js';
import { createEvidence, type Evidence } from './evidence.js';
import { storedEvidenceKind } from './stored-evidence.js';

const EVIDENCE_TAB_ORDER = 30;

/** The drawn relationship a relationship menu is about. */
function edgeOf(context: MenuContext): EdgeRef | undefined {
  if (context.key === undefined) return undefined;
  return partitionEdges(context.state.visibleGraph()).drawable.find((edge) => edgeKey(edge.ref) === context.key)?.ref;
}

function registerMenuItems(menus: MenuRegistry, evidence: Evidence): () => void {
  const offered = (context: MenuContext): 'enabled' | 'hidden' => {
    const ref = edgeOf(context);
    return ref !== undefined && evidence.offers(ref) ? 'enabled' : 'hidden';
  };
  const open = (context: MenuContext): void => {
    const ref = edgeOf(context);
    if (ref !== undefined) evidence.open(ref);
  };
  const removals = [
    menus.register('relationship', { id: 'why-this-relationship', label: WHY_HERE, icon: <span className="icon icon-why" aria-hidden="true" />, group: MENU_GROUP.relationship.explain, order: MENU_ORDER.relationship.explain, hint: '↵', state: offered, run: open }),
    menus.register('relationship', { id: 'view-supporting-records', label: VIEW_SUPPORTING_RECORDS, icon: <span className="icon icon-supporting" aria-hidden="true" />, group: MENU_GROUP.relationship.explain, order: MENU_ORDER.relationship.viewSupportingRecords, state: offered, run: open }),
  ];
  return () => {
    for (const remove of removals) remove();
  };
}

/** The relationship evidence of a workspace: the kind for stored relationships, the docked panel, the two menu items and the inspector's Evidence tab. The function returned takes all of it away. */
export function bindBuiltInEvidence(state: ClientState, panels: PanelRegistry, inspector: Inspector, menus: MenuRegistry): { readonly evidence: Evidence; readonly unbind: () => void } {
  const evidence = createEvidence();
  const removals = [
    evidence.kinds.register(storedEvidenceKind),
    inspector.tabs.register({ id: 'evidence', label: 'Evidence', order: EVIDENCE_TAB_ORDER, content: evidenceTabFor(evidence) }),
    registerMenuItems(menus, evidence),
    bindEvidencePanel(state, panels, evidence),
  ];
  return {
    evidence,
    unbind: () => {
      for (const remove of removals.reverse()) remove();
    },
  };
}
