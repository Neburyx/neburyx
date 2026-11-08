import type { Count, GraphEdge } from '@neburyx/contracts';
import { degreeCountText } from '../workspace/degree-text.js';

export type Origin = GraphEdge['semantics'];

export interface RelationshipLook {
  readonly aggregate: boolean;
  readonly origin: Origin;
  readonly label: string | undefined;
  /** The label with its member count, when the canvas label leaves out a count that says nothing (an exact 1); read in the hover tip. Absent when it is the label. */
  readonly tip?: string;
  /** An aggregate that stands for exactly one relationship: drawn as thin as a stored relationship, since its width would claim more. Absent for every other relationship, and for an aggregate that may hold more than one (a count above one, a lower bound, an estimate or no count). */
  readonly single?: true;
}

/** The member count with its quality in the shared words ("3 · exact", "~ 3 (estimated)", "≥ 3 · lower bound"); no number when the count is unknown, never a guess. */
export function memberCountText(count: Count): string | undefined {
  return count.value === undefined ? undefined : degreeCountText(count);
}

/** The word for an origin that is not stored; a stored relationship has none on the canvas. The one definition, shared by the canvas labels and the menu headers. */
export function originWord(origin: Origin): string | undefined {
  switch (origin) {
    case 'stored':
      return undefined;
    case 'derived':
      return 'derived';
    case 'unknown':
      return 'origin unknown';
    default: {
      const unreachable: never = origin;
      return unreachable;
    }
  }
}

export interface RelationshipParts {
  readonly type: string;
  /** An aggregate's member count with its quality in words; none for another relationship, and none when the count is unknown. */
  readonly count: string | undefined;
  readonly origin: string | undefined;
}

export function relationshipParts(edge: GraphEdge): RelationshipParts {
  const aggregate = 'aggregate' in edge.ref;
  return { type: edge.type, count: aggregate && edge.memberCount !== undefined ? memberCountText(edge.memberCount) : undefined, origin: originWord(edge.semantics) };
}

/** A member count of exactly one, exact, says nothing more than the line itself: the canvas label leaves it out (the tip, the menu header and the walk keep it). */
const isNeedlessCount = (edge: GraphEdge): boolean => edge.memberCount?.quality === 'exact' && edge.memberCount.value === 1;

/** The line style follows the origin and the width follows whether it stands for more than one relationship; the label is the type, then the count of an aggregate (not an exact 1), then the origin when it is not stored. A stored relationship that is not an aggregate carries its type as a label only while an entity it joins is selected. */
export function relationshipLook(edge: GraphEdge, touchesSelection = false): RelationshipLook {
  const aggregate = 'aggregate' in edge.ref;
  const { type, count, origin } = relationshipParts(edge);
  const full = [type, count, origin].filter((part) => part !== undefined).join(' · ');
  const left = aggregate && isNeedlessCount(edge);
  const shown = left ? [type, origin].filter((part) => part !== undefined).join(' · ') : full;
  const always = aggregate || edge.semantics !== 'stored';
  const label = always ? shown : touchesSelection ? edge.type : undefined;
  return { aggregate, origin: edge.semantics, label, ...(left && always ? { tip: full } : {}), ...(aggregate && isNeedlessCount(edge) ? { single: true as const } : {}) };
}
