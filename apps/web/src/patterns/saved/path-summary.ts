import type { PatternWithin } from '@neburyx/contracts';
import { ARROW, extensionTags } from '../copy.js';

/** The path of a pattern in a line, as the builder draws it: the start type, then for each step its relationship types and the type it arrives at, with an arrow for the direction. */
/** The part of a definition the path reads: the start type and, for each step, its direction, relationship types and the type it arrives at. */
export interface PathShape {
  readonly anchorType: string;
  readonly steps: readonly {
    readonly direction: 'out' | 'in' | 'both';
    readonly relationshipTypes: readonly string[];
    readonly arrivesAt: string;
    readonly after?: 'previous' | undefined;
    readonly within?: PatternWithin | undefined;
    readonly fan?: { readonly atLeast: number } | undefined;
    readonly closesAtAnchor?: true | undefined;
  }[];
}

export function pathSummary(definition: PathShape, nameOf: (type: string) => string): string {
  const parts = [nameOf(definition.anchorType)];
  for (const step of definition.steps) {
    const notes = extensionTags(step);
    parts.push(ARROW[step.direction], step.relationshipTypes.join(' or '), ARROW[step.direction], nameOf(step.arrivesAt));
    if (notes.length > 0) parts.push(`(${notes.join(', ')})`);
  }
  return parts.join(' ');
}
