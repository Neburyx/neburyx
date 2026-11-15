import type { ElementRef, GraphNode, PathsRequest, SourceProfile } from '@neburyx/contracts';
import type { FormProblem } from './copy.js';
import { elementKey } from '../state/keys.js';

/** An entity chosen for one end: its reference and the title it was chosen by. */
export interface EndChoice {
  readonly ref: ElementRef;
  readonly title: string;
}

export interface PathsForm {
  readonly from: EndChoice | undefined;
  readonly to: EndChoice | undefined;
  readonly maxHops: number;
  readonly direction: NonNullable<PathsRequest['direction']>;
  readonly limit: number;
  readonly relTypes: ReadonlySet<string>;
}

const DEFAULT_MAX_HOPS = 3;
export const DEFAULT_LIMIT = 5;

export const choiceOf = (node: GraphNode): EndChoice => ({ ref: node.ref, title: node.display.title });

/** The relationship types the profile maps, each once, in the order of the mapping. */
export const relationshipTypesOf = (profile: SourceProfile | undefined): readonly string[] => [...new Set((profile?.relationshipTypes ?? []).map((row) => row.type))];

/** The form a panel opens with: the hops start at 3 (lower when the source allows fewer), the direction is Either, the cap is 5, and every relationship type is allowed. */
export function initialForm(sourceMaxHops: number | undefined, relationshipTypes: readonly string[]): PathsForm {
  return { from: undefined, to: undefined, maxHops: Math.min(DEFAULT_MAX_HOPS, sourceMaxHops ?? DEFAULT_MAX_HOPS), direction: 'both', limit: DEFAULT_LIMIT, relTypes: new Set(relationshipTypes) };
}

export function problemOf(form: PathsForm): FormProblem | undefined {
  if (form.from === undefined) return 'no-from';
  if (form.to === undefined) return 'no-to';
  if (elementKey(form.from.ref) === elementKey(form.to.ref)) return 'same';
  return form.relTypes.size === 0 ? 'no-types' : undefined;
}

/** What one press of **Find paths** sends; the relationship types in the order of the mapping. */
export function requestOf(form: PathsForm, sourceId: string, mask: boolean, allTypes: readonly string[], proceed = false): PathsRequest | undefined {
  if (problemOf(form) !== undefined || form.from === undefined || form.to === undefined) return undefined;
  return {
    sourceId,
    from: { entityType: form.from.ref.entityType, stableId: form.from.ref.stableId },
    to: { entityType: form.to.ref.entityType, stableId: form.to.ref.stableId },
    relTypes: allTypes.filter((type) => form.relTypes.has(type)),
    maxHops: form.maxHops,
    limit: form.limit,
    direction: form.direction,
    ...(mask ? { mask: true } : {}),
    ...(proceed ? { continue: true } : {}),
  };
}
