import type { PatternProblem } from '@neburyx/contracts';
import { MAX_FILTER_TEXT, PATTERN_LIMITS } from '@neburyx/contracts';
import { SHELL_COPY } from '../copy.js';
import { FILTERS_NONE_OFFERED } from '../../workspace/expand-copy.js';
import type { AddConditionBlock } from './conditions.js';
import type { AddStepBlock, Break, Direction } from './model.js';

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

/** The Conditions tab (frames PB4, PB5, PB8 and PB19 state 9). */
export const CONDITIONS_TAB = {
  add: '+ Add condition',
  addMenu: 'Add a condition',
  done: 'Done',
  cancel: 'Cancel',
  relationship: 'Relationship',
  valueTypes: 'Value types: text, number, true / false, date, date-time, time. Date-times and times are in UTC.',
  hiddenTitle: 'Personal-data properties are hidden',
  chooseKind: 'Choose how its value is read in Kind of value.',
} as const;

export const arrivingGroup = (name: string, count: number): string => `Arriving ${name} · ${count} of ${PATTERN_LIMITS.conditionsPerElement}`;
export const relationshipGroup = (types: readonly string[], count: number): string => `${types.join(' or ')} · ${count} of ${PATTERN_LIMITS.conditionsPerElement}`;
export const onArriving = (name: string): string => `On the arriving ${name}`;
export const onRelationship = (types: readonly string[]): string => `On ${types.join(' or ')}`;
export const groupFull = (label: string): string => `${label} has ${PATTERN_LIMITS.conditionsPerElement} of ${PATTERN_LIMITS.conditionsPerElement}. Remove one to add another.`;
export const hiddenInMenu = (count: number): string => `${count} personal-data ${count === 1 ? 'property' : 'properties'} hidden (masking on)`;
export const hiddenOnTab = (count: number): string => `${count} ${count === 1 ? 'property is' : 'properties are'} not offered in conditions, and their values are not shown in matches. Turn masking off in the toolbar if your role allows it.`;
export const editLabel = (summary: string): string => `Edit condition: ${summary}`;
export const removeLabel = (summary: string): string => `Remove condition: ${summary}`;

/** What each kind is called in the menu, and what a value of it looks like. */
export const KIND_NAME: Readonly<Record<string, string>> = { text: 'text', number: 'number', boolean: 'true / false', date: 'date', dateTime: 'date-time', localDateTime: 'date-time (no zone)', time: 'time', localTime: 'time (no zone)' };
const KIND_SENTENCE: Readonly<Record<string, string>> = {
  text: 'text',
  number: 'a number',
  boolean: 'true or false',
  date: 'a date',
  dateTime: 'a date and time with a zone',
  localDateTime: 'a date and time without a zone',
  time: 'a time with a zone',
  localTime: 'a time without a zone',
};
const KIND_VALUE: Readonly<Record<string, string>> = {
  text: `Text, at most ${MAX_FILTER_TEXT} characters.`,
  number: 'Numbers only.',
  boolean: 'true or false.',
  date: 'A calendar date like 2026-03-14.',
  dateTime: 'A date and time with a zone, like 2026-10-31T09:00:00Z.',
  localDateTime: 'A date and time without a zone, like 2026-10-31T09:00:00.',
  time: 'A time with a zone, like 09:00:00Z.',
  localTime: 'A time without a zone, like 09:00:00.',
};

/** The line under Property and Operator: what the property holds and which operators it has. */
export const kindHelp = (property: string, kind: string | undefined, operators: readonly string[]): string =>
  kind === undefined || kind === 'unknown' ? `${property} has no declared kind. ${CONDITIONS_TAB.chooseKind}` : `${property} is ${KIND_SENTENCE[kind] ?? kind}. Operators: ${operators.join(', ')}.`;
/** The line under the values: what one looks like, and that a range includes both ends. */
export const valueHelp = (kind: string | undefined, between: boolean): string => `${kind === undefined || kind === 'unknown' ? 'Type the value to match.' : (KIND_VALUE[kind] ?? 'Type the value to match.')}${between ? ' Both ends are included.' : ''}`;

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

/** The words of the editor's chain, tabs, start and step panels (frames PB2, PB3 and PB8). */
export const EDITOR_COPY = {
  chainNone: 'Chain · no steps yet',
  addStepToContinue: 'Add a step to continue',
  canFollow: 'The mapping can follow this pattern',
  start: 'Start',
  startExplain: 'Every pattern starts from one entity you choose when you run it.',
  startType: 'Starting entity type',
  typesInMapping: 'Entity types in the mapping',
  addStep: '+ Step',
  stepsLabel: 'Pattern steps',
  partsLabel: 'Parts of the step',
  remove: 'Remove step',
  cancel: 'Cancel',
  preview: 'Preview',
  keepEditing: 'Keep editing',
  discardTitle: 'Discard this draft?',
  discardText: 'The pattern you have built is not saved.',
  discard: 'Discard draft',
  removeTitle: (step: number): string => `Remove step ${step}?`,
  removeText: (conditions: number): string => `${conditions} ${conditions === 1 ? 'condition goes' : 'conditions go'} with it.`,
  previewNeedsValid: 'Preview is on once the source has checked the pattern.',
} as const;

export const chainTitle = (steps: number, stepLimit: number, conditions: number): string => (steps === 0 ? EDITOR_COPY.chainNone : `Chain · ${steps} of ${stepLimit} ${stepLimit === 1 ? 'step' : 'steps'} · ${conditions} of ${PATTERN_LIMITS.conditionsPerPattern} conditions`);
export const stepSummary = (types: readonly string[], arrival: string | undefined): string => `${types.length === 0 ? '…' : types.join(' or ')} → ${arrival ?? '…'}`;
export const conditionsTab = (count: number): string => `Conditions · ${count}`;
export const windowTab = (days: number | undefined): string => (days === undefined ? 'Window · none' : `Window · ${days} d`);

/** The Link tab (frame PB3). */
export const LINK_COPY = {
  link: 'Link',
  direction: 'Direction',
  out: 'Outgoing',
  in: 'Incoming',
  both: 'Either',
  arrivesAt: 'Arrives at',
  chooseType: 'Choose a type',
  addType: '+ Add type',
  onlyMapped: 'Only types in the mapping are listed.',
  hasDate: 'has date',
  noDate: 'no date',
  typesAtMost: `At most ${PATTERN_LIMITS.relationshipTypesPerStep} relationship types in a step.`,
} as const;

export const relationshipTypesTitle = (count: number): string => `Relationship types · ${count} of ${PATTERN_LIMITS.relationshipTypesPerStep}`;
export const directionMeaning = (direction: Direction, from: string): string => {
  if (direction === 'out') return `Outgoing: the relationship points from ${from} to the next entity.`;
  if (direction === 'in') return `Incoming: the relationship points to ${from} from the next entity.`;
  return `Either: the relationship may point either way between ${from} and the next entity.`;
};
export const leavingText = (type: string, direction: Direction): string => `Leaving a ${type}, ${direction === 'out' ? 'outgoing' : direction === 'in' ? 'incoming' : 'either direction'}`;
export const removeTypeLabel = (type: string): string => `Remove ${type}`;

/** The Window tab (frame PB6). */
export const WINDOW_COPY = {
  legend: 'Date window on the relationship',
  none: 'None',
  days: 'Last N days',
  dates: 'Between',
  daysField: 'Days',
  daysHelp: 'Counted back from the day you run it, in UTC.',
  from: 'From (UTC date)',
  to: 'To (UTC date)',
  datesHelp: 'Both dates are included, in UTC.',
  canFilter: 'Which types the window can filter',
  noDate: 'no date in the mapping',
} as const;

export const filteredOn = (properties: readonly string[]): string => `filtered on ${properties.join(', ')}`;
export const cannotFilter = (type: string): string => `It cannot be filtered: ${type} is matched without a date limit.`;

/** The words of a change that leaves later parts unfollowed (frame PB7). */
const listOf = (items: readonly string[]): string => (items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`);
const doesNot = (count: number): string => (count === 1 ? 'does not' : 'do not');
export const problemCount = (count: number): string => `${count} ${count === 1 ? 'problem' : 'problems'}`;

export function breakText(found: Break, nameOf: (type: string | undefined) => string): string {
  const step = `Step ${found.step + 1}`;
  switch (found.kind) {
    case 'types-leave':
      return `${step}: ${listOf(found.types)} ${doesNot(found.types.length)} leave a ${nameOf(found.from)}.`;
    case 'types-lead':
      return `${step}: ${listOf(found.types)} ${doesNot(found.types.length)} lead to ${nameOf(found.arrival)} in the mapping.`;
    case 'arrival':
      return `${step}: ${nameOf(found.from)} does not reach ${nameOf(found.arrival)} in this direction.`;
    case 'condition':
      return `${step}: the condition on ${found.row.property} is not available on ${found.row.on === 'neighbor' ? nameOf(found.arrival) : listOf(found.types)}.`;
    case 'window':
      return `${step}: the window needs a relationship type with a date.`;
    default: {
      const unreachable: never = found;
      return unreachable;
    }
  }
}

export const BREAK_COPY = {
  undo: 'Undo change',
  nothingRemoved: 'Nothing is removed for you. Fix each item, or undo the change.',
  fixEach: 'Nothing is removed for you. Fix each item.',
  windowNeedsDate: 'No chosen relationship type has a date, so the window does not apply. Choose a type with a date, or set the window to None.',
} as const;

export const breakTitle = (changed: 'start' | number | undefined, count: number): string => (changed === undefined ? `${problemCount(count)} the mapping does not follow` : `Changing ${changed === 'start' ? 'the start' : `step ${changed + 1}`} leaves ${problemCount(count)}`);
export const chainProblems = (count: number): string => `${problemCount(count)}. Preview is off until they are fixed.`;
export const leadsElsewhere = (type: string, actual: readonly string[], arrival: string): string => `${type} leads to ${actual.join(' or ')}, not ${arrival}.`;
export const doesNotLeave = (type: string, from: string): string => `${type} does not leave a ${from}.`;
export const arrivalChanged = (was: string | undefined, arrival: string): string => `${was === undefined ? '' : `Changed from ${was}. `}Choose types that lead to ${arrival}, or change it back.`;

/** The problems the source found, the checking states and the states of the mapping (frames PB9 and PB19 states 1 to 4). */
export const CHECK_COPY = {
  problemsTitle: 'The mapping cannot follow this pattern yet',
  show: 'Show',
  checking: 'Checking with the source…',
  checkingNote: 'Preview is off until the check finishes. You can keep editing.',
  couldNot: 'The check could not be made.',
  tooMany: 'Too many checks in a short time.',
  loadingMapping: 'Reading the mapping for this source…',
  editingOff: 'Editing is off until it loads. Built-in patterns stay listed.',
  couldNotRead: 'Could not read the mapping.',
  nothingChanged: 'Nothing was changed.',
  close: 'Close',
} as const;

export const sourceProblems = (count: number): string => `${problemCount(count)} from the source. Preview is off.`;
export const PART_NAME = { link: 'Link', conditions: 'Conditions', window: 'Window' } as const;
export const checkedAtText = (at: Date): string => `Checked by the source at ${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')} UTC.`;

/** Why Preview is off, as it is read after its name (PB20). */
export function previewWhy(broken: number, fromSource: number, complete: boolean, check: string): string {
  if (broken > 0) return `unavailable, ${problemCount(broken)}`;
  if (fromSource > 0) return `unavailable, ${problemCount(fromSource)} from the source`;
  if (!complete) return 'unavailable until the pattern is complete';
  return check === 'checking' ? 'unavailable while the source checks the pattern' : 'unavailable until the source has checked the pattern';
}
