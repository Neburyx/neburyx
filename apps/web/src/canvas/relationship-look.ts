import type { Count, GraphEdge } from '@neburyx/contracts';
import { formatNumber } from '../workspace/scope-text.js';

export type Origin = GraphEdge['semantics'];

export interface RelationshipLook {
  readonly aggregate: boolean;
  readonly origin: Origin;
  readonly label: string | undefined;
}

/** The member count with its quality in words; no number when the count is unknown, never a guess. */
export function memberCountText(count: Count): string | undefined {
  if (count.value === undefined) return undefined;
  const value = formatNumber(count.value);
  switch (count.quality) {
    case 'exact':
      return value;
    case 'estimated':
      return `~${value} (estimated)`;
    case 'lowerBound':
      return `≥ ${value} (lower bound)`;
    case 'unknown':
      return undefined;
    default: {
      const unreachable: never = count.quality;
      return unreachable;
    }
  }
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

/** The line style follows the origin and the width follows whether it is an aggregate; the label is the type, then the count of an aggregate, then the origin when it is not stored. A stored relationship that is not an aggregate carries its type as a label only while an entity it joins is selected. */
export function relationshipLook(edge: GraphEdge, touchesSelection = false): RelationshipLook {
  const aggregate = 'aggregate' in edge.ref;
  const { type, count, origin } = relationshipParts(edge);
  const parts = [type, count, origin].filter((part) => part !== undefined);
  const always = aggregate || edge.semantics !== 'stored';
  const label = always ? parts.join(' · ') : touchesSelection ? edge.type : undefined;
  return { aggregate, origin: edge.semantics, label };
}
