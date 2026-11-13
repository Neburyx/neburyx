import type { PatternProblem } from '@neburyx/contracts';
import { PATTERN_LIMITS } from '@neburyx/contracts';
import { SHELL_COPY } from '../copy.js';
import { FILTERS_NONE_OFFERED } from '../../workspace/expand-copy.js';
import type { AddConditionBlock } from './conditions.js';
import type { Direction, AddStepBlock } from './model.js';

/** The words of the builder. "Path" and the two notes are frame 28's; the rest is proposed copy (listed with the frame differences). */
export const BUILDER_COPY = {
  newPattern: SHELL_COPY.newPattern,
  title: SHELL_COPY.newPattern,
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
  restartedByMask: SHELL_COPY.restartedByMask,
} as const;

export const DIRECTION_TEXT: Readonly<Record<Direction, string>> = { out: 'Outgoing', in: 'Incoming', both: 'Either direction' };

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

/** Where a problem is shown: at a condition row or a window of a step, on a step, on the start type, or at the top of the builder when its path names none of them. */
export type ProblemPlace =
  | { readonly kind: 'step'; readonly index: number }
  | { readonly kind: 'condition'; readonly index: number; readonly row: number }
  | { readonly kind: 'window'; readonly index: number }
  | { readonly kind: 'start' }
  | { readonly kind: 'top' };

export function placeOf(problem: PatternProblem): ProblemPlace {
  const [first, second] = problem.path;
  if (first === 'anchorType') return { kind: 'start' };
  if (first === 'steps' && typeof second === 'number') {
    const [, , part, row] = problem.path;
    if (part === 'conditions' && typeof row === 'number') return { kind: 'condition', index: second, row };
    if (part === 'window') return { kind: 'window', index: second };
    return { kind: 'step', index: second };
  }
  return { kind: 'top' };
}

export const CONDITIONS_COPY = {
  legend: 'Conditions',
  add: 'Add condition',
  remove: 'Remove condition',
  arrivalFirst: 'Choose where the step arrives first.',
  patternCap: `At most ${PATTERN_LIMITS.conditionsPerPattern} conditions in a pattern.`,
  windowLegend: 'Window',
  windowKind: 'Window',
  windowNone: 'No window',
  windowDays: 'Last N days',
  windowDates: 'Between two dates',
  windowDaysField: 'Days',
  windowFrom: 'From (UTC date)',
  windowTo: 'To (UTC date)',
  windowNoDated: 'The window does not apply: no chosen relationship type has an observed time in the mapping.',
  windowDropped: 'The window was taken off because no chosen relationship type has an observed time.',
  windowChooseTypes: 'Choose the relationship types first.',
} as const;

export const sideCapText = (on: 'neighbor' | 'relationship'): string => `At most ${PATTERN_LIMITS.conditionsPerElement} conditions on the ${on === 'neighbor' ? 'node' : 'relationship'} of a step.`;
export const windowAppliesText = (types: readonly string[]): string => `Filtered by the window: ${types.join(', ')}.`;
export const windowNotAppliedText = (types: readonly string[]): string => `Not filtered by the window: ${types.join(', ')}. They are read whole.`;

export function conditionBlockText(block: AddConditionBlock): string {
  switch (block.kind) {
    case 'arrival':
      return CONDITIONS_COPY.arrivalFirst;
    case 'none-offered':
      return FILTERS_NONE_OFFERED;
    case 'pattern-cap':
      return CONDITIONS_COPY.patternCap;
    case 'side-cap':
      return sideCapText(block.on);
    default: {
      const unreachable: never = block;
      return unreachable;
    }
  }
}
