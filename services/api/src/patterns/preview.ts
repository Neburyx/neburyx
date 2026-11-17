import { patternDefinitionSchema, type ExpandFilter, type FilterValue, type PatternDefinition, type PatternPreview, type PatternProblem } from '@neburyx/contracts';
import type { SourceModel } from '../mapping/model.js';
import { carries, validatePattern, type PatternValidationOptions } from './validate.js';

const DIRECTION_WORDS: Readonly<Record<PatternDefinition['steps'][number]['direction'], string>> = { out: 'forward', in: 'backward', both: 'in either direction' };

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** A value as the words give it: text in quotes, every other kind as it is given. */
const valueWords = (value: FilterValue): string => (value.kind === 'text' ? `"${value.value}"` : String(value.value));

type Step = PatternDefinition['steps'][number];
type PreviewStep = PatternPreview['steps'][number];

function conditionPart(condition: ExpandFilter, appliesTo: string): PreviewStep['conditions'][number] {
  const base = { on: condition.on, appliesTo, property: condition.property, op: condition.op };
  const lead = `${appliesTo}: ${condition.property}`;
  if (condition.op === 'eq') return { ...base, values: [condition.value], text: `${lead} is ${valueWords(condition.value)}` };
  if (condition.op === 'in') return { ...base, values: condition.values, text: `${lead} is one of ${condition.values.map(valueWords).join(', ')}` };
  const { from, to } = condition;
  const range = from !== undefined && to !== undefined ? `between ${valueWords(from)} and ${valueWords(to)}` : from !== undefined ? `from ${valueWords(from)}` : to !== undefined ? `up to ${valueWords(to)}` : '';
  return { ...base, values: [], ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), text: `${lead} is ${range}` };
}

/**
 * The window in words, for the types of the step that carry a date in the mapping (`observed_at`) and, said apart, for those that carry none, which a window does not filter. The rows read are the ones that carry the step (the
 * previous type to the type it arrives at, in its direction), as the run reads them: a type is in `appliesTo` when one of those rows has a date and in `notAppliedTo` when one has none, so a type can be in both.
 */
function windowPart(window: NonNullable<Step['window']>, step: Step, previous: string, source: SourceModel): NonNullable<PreviewStep['window']> {
  const types = step.relationshipTypes;
  const rowsOf = (type: string) => source.relationships.filter((row) => row.type === type && carries(row, previous, step.arrivesAt, step.direction));
  const appliesTo = types.filter((type) => rowsOf(type).some((row) => row.observedAt !== undefined));
  const notAppliedTo = types.filter((type) => rowsOf(type).some((row) => row.observedAt === undefined));
  const span = 'days' in window ? `the last ${plural(window.days, 'day', 'days')} and today (UTC)` : `from ${window.from} to ${window.to}, both included (UTC)`;
  const parts = [appliesTo.length === 0 ? undefined : `Window on ${appliesTo.join(' or ')}: ${span}`, notAppliedTo.length === 0 ? undefined : `The window does not apply to ${notAppliedTo.join(' or ')}: no date is declared for ${notAppliedTo.length === 1 ? 'it' : 'them'}`].filter((part) => part !== undefined);
  return { appliesTo, notAppliedTo, ...('days' in window ? { days: window.days } : { from: window.from, to: window.to }), text: parts.join('. ') };
}

/** A fan in words: the phrase of the step's sentence; a neighbour reached by more than one relationship counts once. */
function fanPart(atLeast: number, direction: Step['direction'], arrives: string): NonNullable<PreviewStep['fan']> {
  return { atLeast, direction, text: `at least ${atLeast} other ${arrives}s` };
}

/** The delay of a step in words, in the unit the definition wrote. */
function withinPart(within: NonNullable<Step['within']>): NonNullable<NonNullable<PreviewStep['timeOrder']>['within']> {
  if ('minutes' in within) return { unit: 'minutes', amount: within.minutes, text: `within ${plural(within.minutes, 'minute', 'minutes')}` };
  if ('hours' in within) return { unit: 'hours', amount: within.hours, text: `within ${plural(within.hours, 'hour', 'hours')}` };
  return { unit: 'days', amount: within.days, text: `within ${plural(within.days, 'day', 'days')}` };
}

/** A time order in words: the relationship of this step has a date the same as or later than the previous step's, read on the time properties the mapping gives each, and no later than the delay when the step has one. */
function timeOrderPart(step: Step, before: Step | undefined, beforePrevious: string, previous: string, source: SourceModel): NonNullable<PreviewStep['timeOrder']> {
  const propertiesOf = (found: Step | undefined, from: string, to: string): string[] => [...new Set((found?.relationshipTypes ?? []).flatMap((type) => source.relationships.filter((row) => row.type === type && found !== undefined && carries(row, from, to, found.direction)).flatMap((row) => (row.observedAt === undefined ? [] : [row.observedAt]))))];
  const properties = propertiesOf(step, previous, step.arrivesAt);
  const previousProperties = propertiesOf(before, beforePrevious, previous);
  const within = step.within === undefined ? undefined : withinPart(step.within);
  return { properties, previousProperties, ...(within === undefined ? {} : { within }), text: `after the previous step (by ${properties.join(' or ')})${within === undefined ? '' : `, ${within.text}`}` };
}

/** The sentence of a step: the chain as before, and for the kinds of the extension the words of the approved frames: to at least N other Accounts, close back at the start Account, after the previous step (by the time property), and within a delay. */
function stepText(index: number, step: Step, types: string, arrives: string, start: string, timeOrderText: string | undefined): string {
  const lead = `Step ${index + 1}: follow ${types} ${DIRECTION_WORDS[step.direction]}`;
  const fan = step.fan === undefined ? '' : ` with at least ${step.fan.atLeast} other ${arrives}s to choose from`;
  const to = step.closesAtAnchor === undefined ? (step.fan === undefined ? `to ${arrives}` : `to at least ${step.fan.atLeast} other ${arrives}s`) : `and close back at the start ${start}${fan}`;
  return `${lead} ${to}${timeOrderText === undefined ? '' : `, ${timeOrderText}`}`;
}

/** What a type is called: the mapping's display name for it, else its label, as the profile gives them. */
function nameOf(source: SourceModel, type: string): string {
  const found = source.entities.find((entity) => entity.type === type);
  return found === undefined ? type : (found.display.name ?? found.label);
}

/** The preview of a definition that is acceptable for the source: typed parts, each with the words the client joins. Every number is the source's own, read from its budgets. */
function previewPattern(definition: PatternDefinition, source: SourceModel): PatternPreview {
  const { maxHops, maxPage, heavyOpThreshold } = source.budgets;
  const start = nameOf(source, definition.anchorType);
  return {
    start: { type: definition.anchorType, name: start, text: `Start: ${start}` },
    steps: definition.steps.map((step, index) => {
      const previous = index === 0 ? definition.anchorType : (definition.steps[index - 1]?.arrivesAt ?? definition.anchorType);
      const arrives = nameOf(source, step.arrivesAt);
      const types = step.relationshipTypes.join(' or ');
      const timeOrder = step.after === undefined ? undefined : timeOrderPart(step, definition.steps[index - 1], index === 0 ? definition.anchorType : (definition.steps[index - 2]?.arrivesAt ?? definition.anchorType), previous, source);
      return {
        relationshipTypes: step.relationshipTypes,
        direction: step.direction,
        arrivesAt: { type: step.arrivesAt, name: arrives },
        text: stepText(index, step, types, arrives, start, timeOrder?.text),
        conditions: (step.conditions ?? []).map((condition) => conditionPart(condition, condition.on === 'neighbor' ? arrives : types)),
        ...(step.window === undefined ? {} : { window: windowPart(step.window, step, previous, source) }),
        ...(step.fan === undefined ? {} : { fan: fanPart(step.fan.atLeast, step.direction, arrives) }),
        ...(timeOrder === undefined ? {} : { timeOrder }),
        ...(step.closesAtAnchor === undefined ? {} : { closesAtAnchor: { type: definition.anchorType, name: start, text: `close back at the start ${start}` } }),
      };
    }),
    bounds: {
      hopLimit: { value: maxHops, text: `At most ${plural(maxHops, 'step', 'steps')} in a pattern` },
      pageLimit: { value: maxPage, text: `At most ${plural(maxPage, 'result', 'results')} at a time` },
      countCap: { value: heavyOpThreshold, text: `Counting stops at ${heavyOpThreshold}: beyond it a count is shown as a lower bound` },
    },
  };
}

export type PatternPreviewResult = { readonly status: 'ok'; readonly preview: PatternPreview } | { readonly status: 'invalid'; readonly problems: PatternProblem[] };

/** The preview of any input for a source: its problems when it does not validate (the validation's own, and no preview), else the preview. */
export function previewOrProblems(input: unknown, source: SourceModel, options: PatternValidationOptions = {}): PatternPreviewResult {
  const problems = validatePattern(input, source, options);
  if (problems.length > 0) return { status: 'invalid', problems };
  return { status: 'ok', preview: previewPattern(patternDefinitionSchema.parse(input), source) };
}
