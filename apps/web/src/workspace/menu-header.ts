import type { SourceProfile } from '@neburyx/contracts';
import { entityLook } from '../canvas/entity-look.js';
import { relationshipParts } from '../canvas/relationship-look.js';
import { isUnmappedEdge, isUnmappedNode, NO_LONGER_MAPPED, UNMAPPED_TITLE } from '../draft/unmapped.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { edgeKey, elementKey } from '../state/keys.js';
import type { OpenMenu } from '../state/presentation-state.js';

export interface MenuHeader {
  readonly title: string;
  readonly detail: string;
}

/** What a stored relationship is called where the canvas draws no word for it. */
const STORED_ORIGIN = 'sourced';

/** The header of the menu of an entity (its ref, then its type and state) or of a relationship (its type, count and origin, then its endpoints and, when it is derived, its rule); none for the canvas, and none for an item that is not loaded. */
export function menuHeader(open: OpenMenu, graph: LoadedGraph, profile: SourceProfile | undefined): MenuHeader | undefined {
  if (open.kind === 'node') {
    const node = graph.nodes.find((candidate) => elementKey(candidate.ref) === open.key);
    if (node === undefined) return undefined;
    if (isUnmappedNode(node)) return { title: UNMAPPED_TITLE, detail: NO_LONGER_MAPPED };
    // the reference of a keyed entity is a token that means nothing to a person: its display title (masked under a mask) stands in the header
    const keyed = profile?.entityTypes.find((candidate) => candidate.type === node.ref.entityType)?.keyed === true;
    return { title: keyed ? node.display.title : node.ref.stableId, detail: entityLook(node, profile).line2 };
  }
  if (open.kind === 'relationship') {
    const edge = graph.edges.find((candidate) => edgeKey(candidate.ref) === open.key);
    if (edge === undefined) return undefined;
    if (isUnmappedEdge(edge)) return { title: 'Unmapped relationship', detail: NO_LONGER_MAPPED };
    const { type, count, origin } = relationshipParts(edge);
    const title = [type, count, origin ?? STORED_ORIGIN].filter((part) => part !== undefined).join(' · ');
    const ends = `${edge.from.stableId} ↔ ${edge.to.stableId}`;
    const observed = 'aggregate' in edge.ref && edge.observedFirst !== undefined ? ` · first ${edge.observedFirst} · last ${edge.observedLast ?? edge.observedFirst}` : '';
    const rule = edge.semantics === 'derived' && edge.derivation !== undefined ? ` · ${edge.derivation.ruleId} v${edge.derivation.ruleVersion}` : '';
    return { title, detail: `${ends}${observed}${rule}` };
  }
  return undefined;
}
