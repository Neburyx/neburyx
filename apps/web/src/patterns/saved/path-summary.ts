import type { PatternDefinition } from '@neburyx/contracts';
import { ARROW } from '../copy.js';

/** The path of a pattern in a line, as the builder draws it: the start type, then for each step its relationship types and the type it arrives at, with an arrow for the direction. */
export function pathSummary(definition: PatternDefinition, nameOf: (type: string) => string): string {
  const parts = [nameOf(definition.anchorType)];
  for (const step of definition.steps) parts.push(ARROW[step.direction], step.relationshipTypes.join(' or '), ARROW[step.direction], nameOf(step.arrivesAt));
  return parts.join(' ');
}
