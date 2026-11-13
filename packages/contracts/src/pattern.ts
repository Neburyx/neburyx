import { z } from 'zod';
import { EXPAND_DIRECTIONS, MAX_FILTER_TEXT, MAX_FILTERS, MAX_FILTER_VALUES, expandFilterSchema, filterShapeProblem, type ExpandFilter } from './expand.js';
import { windowSchema, type Window } from './template-run.js';

/**
 * The limits of a pattern. The ones marked "Builder limit" are builder limits, decided 2026-11-12; the others are the limits the rest of the API already holds, reused so that one number has one home.
 * `steps` equals the API's `MAX_HOPS_CEILING` (a test in the API keeps them equal); the source's own `max_hops` is enforced by the gate at run time.
 */
export const PATTERN_LIMITS = {
  steps: 4,
  /** Builder limit. */
  relationshipTypesPerStep: 6,
  conditionsPerElement: MAX_FILTERS,
  /** Builder limit. */
  conditionsPerPattern: 24,
  valuesPerCondition: MAX_FILTER_VALUES,
  /** Builder limit, used by the store of saved patterns. */
  patternsPerSource: 200,
  /** Builder limit, used by the store of saved patterns. */
  nameLength: 100,
} as const;

/** What a problem with a pattern is: the shape and the caps (the schema) first, then what the source's mapping does not allow. The code says what is wrong; the path says where; nothing else is carried. */
export const PATTERN_PROBLEM_CODES = [
  'unknown-key',
  'wrong-type',
  'missing',
  'too-many',
  'too-few',
  'bad-value',
  'bad-shape',
  'unknown-entity-type',
  'unknown-relationship-type',
  'relationship-does-not-join',
  'unknown-property',
  'not-filterable',
  'personal-data-masked',
] as const;
/** The most problems one answer lists, so that an input with many faults cannot make an answer of unbounded size. */
export const MAX_PATTERN_PROBLEMS = 100;
export type PatternProblemCode = (typeof PATTERN_PROBLEM_CODES)[number];

export const patternProblemSchema = z.strictObject({ path: z.array(z.union([z.string(), z.number().int().nonnegative()])), code: z.enum(PATTERN_PROBLEM_CODES) });
export type PatternProblem = z.infer<typeof patternProblemSchema>;

const name = z.string().min(1).max(MAX_FILTER_TEXT);
type Path = readonly (string | number | symbol)[];

const BRANCHES = expandFilterSchema.options;

/** The branch of the condition union a value's `op` names, so that a fault inside a condition is a fault at its own place and not a failed union. */
function branchOf(value: unknown) {
  const op = typeof value === 'object' && value !== null && 'op' in value ? value.op : undefined;
  return BRANCHES.find((branch) => branch.shape.op.value === op);
}

const valueAt = (root: unknown, path: Path): unknown => path.reduce<unknown>((node, key) => (typeof node === 'object' && node !== null ? (node as Record<string | number | symbol, unknown>)[key] : undefined), root);

/** The code of one schema issue: custom issues carry theirs; the others are read from the issue and, for a missing member, from the input. */
function codeOf(issue: z.core.$ZodIssue, input: unknown): PatternProblemCode {
  if (issue.code === 'custom') {
    const problem = issue.params?.['problem'];
    return PATTERN_PROBLEM_CODES.find((code) => code === problem) ?? 'bad-value';
  }
  if (issue.code === 'unrecognized_keys') return 'unknown-key';
  if (issue.code === 'invalid_type') return valueAt(input, issue.path) === undefined ? 'missing' : 'wrong-type';
  if (issue.code === 'too_big') return issue.origin === 'array' ? 'too-many' : 'bad-value';
  if (issue.code === 'too_small') return issue.origin === 'array' ? 'too-few' : 'bad-value';
  return 'bad-value';
}

/** One condition: checked against the branch its `op` names (the options of `expandFilterSchema`, reused), with the shape rules of `filterShapeProblem`. */
const conditionSchema = z.custom<ExpandFilter>().superRefine((value, ctx) => {
  const branch = branchOf(value);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    ctx.addIssue({ code: 'custom', params: { problem: 'wrong-type' } });
    return;
  }
  if (branch === undefined) {
    ctx.addIssue({ code: 'custom', path: ['op'], params: { problem: 'op' in value ? 'bad-value' : 'missing' } });
    return;
  }
  const parsed = branch.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: [...issue.path], params: { problem: codeOf(issue, value) } });
    return;
  }
  if (filterShapeProblem(parsed.data) !== undefined) ctx.addIssue({ code: 'custom', params: { problem: 'bad-shape' } });
});

/** A window: days, or a range of dates; checked against the branch it names (`days` or not), so that a key it does not name is an unknown key at the window and not a failed union. */
const windowFieldSchema = z.custom<Window>().superRefine((value, ctx) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    ctx.addIssue({ code: 'custom', params: { problem: 'wrong-type' } });
    return;
  }
  const [days, range] = windowSchema.options;
  const parsed = ('days' in value ? days : range).safeParse(value);
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: [...issue.path], params: { problem: codeOf(issue, value) } });
});

const stepSchema = z
  .strictObject({
    relationshipTypes: z.array(name).min(1).max(PATTERN_LIMITS.relationshipTypesPerStep),
    direction: z.enum(EXPAND_DIRECTIONS),
    arrivesAt: name,
    conditions: z.array(conditionSchema).max(2 * PATTERN_LIMITS.conditionsPerElement).optional(),
    window: windowFieldSchema.optional(),
  })
  .superRefine((step, ctx) => {
    const seen = new Set<string>();
    step.relationshipTypes.forEach((type, index) => {
      if (seen.has(type)) ctx.addIssue({ code: 'custom', path: ['relationshipTypes', index], params: { problem: 'bad-value' } });
      seen.add(type);
    });
    for (const on of ['neighbor', 'relationship'] as const) {
      if ((step.conditions ?? []).filter((condition) => condition.on === on).length > PATTERN_LIMITS.conditionsPerElement) ctx.addIssue({ code: 'custom', path: ['conditions'], params: { problem: 'too-many' } });
    }
  });

/**
 * A pattern: where it starts (the type of the entity a run is given) and the steps that follow. Each step walks over one or several relationship types in a direction to a node type, with conditions on that node and on the
 * relationship and a window on the relationship. Every object is strict, and there is no field that holds text to be parsed.
 */
export const patternDefinitionSchema = z
  .strictObject({
    anchorType: name,
    steps: z.array(stepSchema).min(1).max(PATTERN_LIMITS.steps),
  })
  .superRefine((definition, ctx) => {
    const total = definition.steps.reduce((sum, step) => sum + (step.conditions?.length ?? 0), 0);
    if (total > PATTERN_LIMITS.conditionsPerPattern) ctx.addIssue({ code: 'custom', path: ['steps'], params: { problem: 'too-many' } });
  });

export type PatternDefinition = z.infer<typeof patternDefinitionSchema>;
export type PatternStep = z.infer<typeof stepSchema>;

/**
 * The problems of a definition that fails the schema, in the order the schema finds them: the code and the path of each, and nothing else (no message, no value, and for an unknown key the path of the object that holds it, never
 * the key). A definition that passes has none.
 */
export function patternProblemsOf(input: unknown): PatternProblem[] {
  const parsed = patternDefinitionSchema.safeParse(input);
  if (parsed.success) return [];
  const problems: PatternProblem[] = [];
  const seen = new Set<string>();
  for (const issue of parsed.error.issues) {
    const problem: PatternProblem = { path: issue.path.filter((key): key is string | number => typeof key === 'string' || typeof key === 'number'), code: codeOf(issue, input) };
    const key = JSON.stringify(problem);
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(problem);
    if (problems.length === MAX_PATTERN_PROBLEMS) break;
  }
  return problems;
}

/** `POST /v1/patterns/validate`: the source, the definition (any object, so that a bad one is answered with its problems and not refused as a bad request) and whether masking is asked, which makes a condition on personal data a problem. */
export const patternValidateRequestSchema = z.strictObject({
  sourceId: z.string().min(1),
  definition: z.record(z.string(), z.unknown()),
  mask: z.boolean().optional(),
});

export const patternValidateResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok') }),
  z.strictObject({ status: z.literal('invalid'), problems: z.array(patternProblemSchema).min(1) }),
]);

export type PatternValidateRequest = z.infer<typeof patternValidateRequestSchema>;
export type PatternValidateResponse = z.infer<typeof patternValidateResponseSchema>;
