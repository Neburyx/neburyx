import type { PatternProblem, PatternProblemCode } from '@neburyx/contracts';
import { PATTERN_LIMITS } from '@neburyx/contracts';
import type { Direction, AddStepBlock } from './model.js';

/** The words of the builder. "Path" and the two notes are frame 28's; the rest is proposed copy (listed with the frame differences). */
export const BUILDER_COPY = {
  newPattern: 'New pattern',
  title: 'New pattern',
  back: 'Back to patterns',
  intro: 'Compose a pattern from your mapping. There is no query text field.',
  mappingNote: 'Types come from the mapping. A type that is not mapped cannot be chosen.',
  startsAt: 'Starts at',
  chooseType: 'Choose a type',
  path: 'Path',
  addStep: 'Add step',
  removeStep: 'Remove step',
  loadingProfile: 'Loading the mapping…',
  profileFailed: 'The mapping could not be read.',
  retry: 'Retry',
  direction: 'Direction',
  chooseDirection: 'Choose a direction',
  arrivesAt: 'Arrives at',
  chooseArrival: 'Choose a type',
  relationshipTypes: 'Relationship types',
  removed: 'Steps after this one were removed because they no longer follow from it.',
  checking: 'Checking…',
  valid: 'Valid: the mapping can follow this pattern.',
  invalid: 'Not valid. The mapping cannot follow this pattern as it is.',
  checkFailed: 'The check could not be made.',
  needsStart: 'Choose where the pattern starts first.',
  needsComplete: 'Complete the last step first.',
} as const;

export const DIRECTION_TEXT: Readonly<Record<Direction, string>> = { out: 'Outgoing', in: 'Incoming', both: 'Either direction' };
export const ARROW: Readonly<Record<Direction, string>> = { out: '→', in: '←', both: '↔' };

export const stepTitle = (index: number): string => `Step ${index + 1}`;
export const tooManyTypes = `At most ${PATTERN_LIMITS.relationshipTypesPerStep} relationship types in a step.`;
export const stepsLine = (count: number, limit: number): string => `Steps ${count} (source limit ${limit})`;
export const noArrival = (type: string): string => `No relationship type in the mapping joins ${type} in this direction.`;

export function blockText(block: AddStepBlock, displayName: (type: string) => string): string {
  switch (block.kind) {
    case 'start':
      return BUILDER_COPY.needsStart;
    case 'incomplete':
      return BUILDER_COPY.needsComplete;
    case 'limit':
      return `This source allows at most ${block.limit} steps.`;
    case 'dead-end':
      return `No relationship type in the mapping joins ${displayName(block.type)}.`;
    default: {
      const unreachable: never = block;
      return unreachable;
    }
  }
}

const PROBLEM_TEXT: Readonly<Record<PatternProblemCode, string>> = {
  'unknown-key': 'This part of the pattern has something the mapping does not know.',
  'wrong-type': 'This part of the pattern is not in the form the mapping expects.',
  missing: 'Something is missing here.',
  'too-many': 'There are more here than a pattern may have.',
  'too-few': 'There are fewer here than a pattern needs.',
  'too-many-hops': 'This pattern has more steps than the source allows.',
  'bad-value': 'This choice is not allowed.',
  'bad-shape': 'This choice does not fit with the others.',
  'unknown-entity-type': 'This type is not in the mapping.',
  'unknown-relationship-type': 'This relationship type is not in the mapping.',
  'relationship-does-not-join': 'This relationship type does not join the types of this step in this direction.',
  'unknown-property': 'This property is not in the mapping.',
  'not-filterable': 'This property cannot be used in a condition.',
  'personal-data-masked': 'This property holds personal data and cannot be used while masking is on.',
};

export const problemText = (problem: PatternProblem): string => PROBLEM_TEXT[problem.code];

/** Where a problem is shown: on a step, on the start type, or at the top of the builder when its path names neither. */
export type ProblemPlace = { readonly kind: 'step'; readonly index: number } | { readonly kind: 'start' } | { readonly kind: 'top' };

export function placeOf(problem: PatternProblem): ProblemPlace {
  const [first, second] = problem.path;
  if (first === 'anchorType') return { kind: 'start' };
  if (first === 'steps' && typeof second === 'number') return { kind: 'step', index: second };
  return { kind: 'top' };
}
