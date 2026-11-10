import type { EdgeRef } from '@neburyx/contracts';
import type { Inspector } from '../inspector/inspector.js';
import type { ClientState } from '../state/client-state.js';
import { edgeKey } from '../state/keys.js';
import { partitionEdges } from '../state/loaded-graph.js';
import { MENU_GROUP, MENU_ORDER, type MenuContext, type MenuRegistry } from '../workspace/menu-registry.js';
import type { PanelRegistry } from '../workspace/panel-registry.js';
import { isUnmappedEdge } from '../draft/unmapped.js';
import { OPEN_SOURCE_RECORD, offersRecordLink, openSourceLink, recordLinkHref } from '../workspace/source-link.js';
import { VIEW_SUPPORTING_RECORDS, WHY_HERE } from './copy.js';
import { bindEvidencePanel } from './evidence-binder.js';
import { evidenceTabFor } from './evidence-tab.js';
import { aggregateEvidenceKind } from './aggregate-evidence.js';
import { derivedEvidenceKind } from './derived-evidence.js';
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
  const storedOf = (context: MenuContext) => {
    const ref = edgeOf(context);
    return ref !== undefined && 'stableId' in ref && evidence.offers(ref) ? ref : undefined;
  };
  const linked = (context: MenuContext): 'enabled' | 'hidden' => {
    const ref = storedOf(context);
    return ref !== undefined && offersRecordLink(context.profile, ref) ? 'enabled' : 'hidden';
  };
  const openRecord = (context: MenuContext): void => {
    const ref = storedOf(context);
    if (ref === undefined) return;
    const mask = context.state.mask.getState();
    const read = context.edgeReads?.forEdge(ref, mask).getState();
    const records = read?.phase === 'ready' && read.data.semantics === 'stored' && read.data.evidence.status === 'available' ? read.data.evidence.records.filter((record) => !('unreadable' in record) && record.linkable) : [];
    const [only] = records;
    if (records.length === 1 && only !== undefined && !('unreadable' in only)) openSourceLink(recordLinkHref(ref, only.sourceRecordId, mask));
    else evidence.open(ref);
  };
  const removals = [
    menus.register('relationship', { id: 'why-this-relationship', label: WHY_HERE, icon: <span className="icon icon-why" aria-hidden="true" />, group: MENU_GROUP.relationship.explain, order: MENU_ORDER.relationship.explain, hint: '↵', state: offered, run: open }),
    menus.register('relationship', { id: 'view-supporting-records', label: VIEW_SUPPORTING_RECORDS, icon: <span className="icon icon-supporting" aria-hidden="true" />, group: MENU_GROUP.relationship.explain, order: MENU_ORDER.relationship.viewSupportingRecords, state: offered, run: open }),
    menus.register('relationship', { id: 'open-source-record', label: OPEN_SOURCE_RECORD, icon: <span className="icon icon-open-record" aria-hidden="true" />, group: MENU_GROUP.relationship.copy, order: MENU_ORDER.relationship.openSourceRecord, state: linked, run: openRecord }),
  ];
  return () => {
    for (const remove of removals) remove();
  };
}

/** The relationship evidence of a workspace: the kinds for stored, derived and aggregate relationships, the docked panel, the two menu items and the inspector's Evidence tab. The function returned takes all of it away. */
export function bindBuiltInEvidence(state: ClientState, panels: PanelRegistry, inspector: Inspector, menus: MenuRegistry): { readonly evidence: Evidence; readonly unbind: () => void } {
  const evidence = createEvidence((ref) => !state.loadedGraph().edges.some((edge) => isUnmappedEdge(edge) && edgeKey(edge.ref) === edgeKey(ref)));
  const removals = [
    evidence.kinds.register(storedEvidenceKind),
    evidence.kinds.register(derivedEvidenceKind),
    evidence.kinds.register(aggregateEvidenceKind),
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
