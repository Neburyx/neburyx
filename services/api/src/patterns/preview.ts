import { patternDefinitionSchema, type ExpandFilter, type FilterValue, type PatternDefinition, type PatternPreview, type PatternProblem } from '@neburyx/contracts';
import type { SourceModel } from '../mapping/model.js';
import { validatePattern, type PatternValidationOptions } from './validate.js';

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

/** The window in words, for the types of the step that carry a date in the mapping (`observed_at`) and, said apart, for those that carry none, which a window does not filter. */
function windowPart(window: NonNullable<Step['window']>, types: readonly string[], source: SourceModel): NonNullable<PreviewStep['window']> {
  const dated = (type: string): boolean => source.relationships.some((row) => row.type === type && row.observedAt !== undefined);
  const appliesTo = types.filter(dated);
  const notAppliedTo = types.filter((type) => !dated(type));
  const span = 'days' in window ? `the last ${plural(window.days, 'day', 'days')} (UTC)` : `from ${window.from} to ${window.to}, both included (UTC)`;
  const parts = [appliesTo.length === 0 ? undefined : `Window on ${appliesTo.join(' or ')}: ${span}`, notAppliedTo.length === 0 ? undefined : `The window does not apply to ${notAppliedTo.join(' or ')}: no date is declared for ${notAppliedTo.length === 1 ? 'it' : 'them'}`].filter((part) => part !== undefined);
  return { appliesTo, notAppliedTo, ...('days' in window ? { days: window.days } : { from: window.from, to: window.to }), text: parts.join('. ') };
}

/** What a type is called: the mapping's display name for it, else its label, as the profile gives them. */
function nameOf(source: SourceModel, type: string): string {
  const found = source.entities.find((entity) => entity.type === type);
  return found === undefined ? type : (found.display.name ?? found.label);
}

/** The preview of a definition that is acceptable for the source: typed parts, each with the words the client joins. Every number is the source's own, read from its budgets. */
export function previewPattern(definition: PatternDefinition, source: SourceModel): PatternPreview {
  const { maxHops, maxPage, heavyOpThreshold } = source.budgets;
  const start = nameOf(source, definition.anchorType);
  return {
    start: { type: definition.anchorType, name: start, text: `Start: ${start}` },
    steps: definition.steps.map((step, index) => {
      const arrives = nameOf(source, step.arrivesAt);
      const types = step.relationshipTypes.join(' or ');
      return {
        relationshipTypes: step.relationshipTypes,
        direction: step.direction,
        arrivesAt: { type: step.arrivesAt, name: arrives },
        text: `Step ${index + 1}: follow ${types} ${DIRECTION_WORDS[step.direction]} to ${arrives}`,
        conditions: (step.conditions ?? []).map((condition) => conditionPart(condition, condition.on === 'neighbor' ? arrives : types)),
        ...(step.window === undefined ? {} : { window: windowPart(step.window, step.relationshipTypes, source) }),
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
