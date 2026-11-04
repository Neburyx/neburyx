import type { SourceProfile } from '@neburyx/contracts';
import { entityLook } from '../canvas/entity-look.js';
import { relationshipParts } from '../canvas/relationship-look.js';
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
    return node === undefined ? undefined : { title: node.ref.stableId, detail: entityLook(node, profile).line2 };
  }
  if (open.kind === 'relationship') {
    const edge = graph.edges.find((candidate) => edgeKey(candidate.ref) === open.key);
    if (edge === undefined) return undefined;
    const { type, count, origin } = relationshipParts(edge);
    const title = [type, count, origin ?? STORED_ORIGIN].filter((part) => part !== undefined).join(' · ');
    const ends = `${edge.from.stableId} ↔ ${edge.to.stableId}`;
    const rule = edge.semantics === 'derived' && edge.derivation !== undefined ? ` · ${edge.derivation.ruleId} v${edge.derivation.ruleVersion}` : '';
    return { title, detail: `${ends}${rule}` };
  }
  return undefined;
}
