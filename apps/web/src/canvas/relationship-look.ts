import type { Count, GraphEdge } from '@neburyx/contracts';
import { degreeCountText } from '../workspace/degree-text.js';

export type Origin = GraphEdge['semantics'];

export interface RelationshipLook {
  readonly aggregate: boolean;
  readonly origin: Origin;
  /** What the canvas draws on the line when labels are read: the type for every relationship, then the count of an aggregate (not an exact 1), then the origin when it is not stored. Absent only for the link from an entity to its aggregate nodes. */
  readonly label: string | undefined;
  /** The count alone of an aggregate that may stand for more than one relationship, which stays drawn when labels are not read; absent for every other relationship and when the count is unknown. */
  readonly badge?: string;
  /** An entity the relationship joins is selected, so its label is drawn even when labels are not read. */
  readonly touched?: true;
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

/** The line style follows the origin and the width follows whether it stands for more than one relationship; the label is the type, then the count of an aggregate (not an exact 1), then the origin when it is not stored. Every relationship carries one: the canvas draws it on hover, when an end is selected and at or above the zoom where captions are read, and below that zoom keeps only an aggregate's count. */
export function relationshipLook(edge: GraphEdge, touchesSelection = false): RelationshipLook {
  const aggregate = 'aggregate' in edge.ref;
  const { type, count, origin } = relationshipParts(edge);
  const full = [type, count, origin].filter((part) => part !== undefined).join(' · ');
  const left = aggregate && isNeedlessCount(edge);
  const shown = left ? [type, origin].filter((part) => part !== undefined).join(' · ') : full;
  const label = shown;
  const showsCount = aggregate && !isNeedlessCount(edge) && count !== undefined;
  return { aggregate, origin: edge.semantics, label, ...(touchesSelection ? { touched: true as const } : {}), ...(showsCount ? { badge: count } : {}), ...(left ? { tip: full } : {}), ...(aggregate && isNeedlessCount(edge) ? { single: true as const } : {}) };
}
