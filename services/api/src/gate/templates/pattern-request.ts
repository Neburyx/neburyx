import { PATTERN_LIMITS, patternStepBaseSchema, referenceValueSchema, refinePatternStep, type ExpandFilter } from '@neburyx/contracts';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { Params, SourceAllowlist } from '../types.js';
import { expandBranchesOf, undeclaredFilter, type ExpandBranch } from './expand-statement.js';
import { integerCandidateOf } from './stable-id.js';

const instant = z.iso.datetime({ offset: true });

/** One step of a run: the definition's step with its window already resolved to two instants. */
const stepParamsSchema = patternStepBaseSchema
  .omit({ window: true })
  .extend({ windowFrom: instant.optional(), windowTo: instant.optional() })
  .superRefine((step, ctx) => {
    refinePatternStep(step, ctx);
    if ((step.windowFrom === undefined) !== (step.windowTo === undefined)) ctx.addIssue({ code: 'custom', message: 'a window has both instants or neither' });
  });

const stepsSchema = z.array(stepParamsSchema).min(1).max(PATTERN_LIMITS.steps);

/** The parameters of a pattern run: the anchor's type and stable ID and the steps, whose conditions and windows are values the statement reads by position. */
export const patternParamsSchema = z
  .strictObject({ anchorType: z.string().min(1), stableId: referenceValueSchema, steps: stepsSchema })
  .superRefine((params, ctx) => {
    if (params.steps.reduce((sum, step) => sum + (step.conditions?.length ?? 0), 0) > PATTERN_LIMITS.conditionsPerPattern) ctx.addIssue({ code: 'custom', path: ['steps'], message: 'too many conditions' });
  })
  .transform((params) => ({ ...params, stableInteger: integerCandidateOf(params.stableId) }));

export interface PatternStepRequest {
  /** The entity type the step starts from: the anchor's for the first step, then the previous step's. */
  readonly from: string;
  readonly arrivesAt: string;
  /** The mapping rows the step crosses, one for each row and direction that joins `from` to `arrivesAt`. */
  readonly branches: readonly ExpandBranch[];
  readonly conditions: readonly ExpandFilter[];
  readonly windowed: boolean;
}

export interface PatternRequest {
  readonly anchor: string;
  readonly steps: readonly PatternStepRequest[];
  /** The properties that put an entity of a type on a stop-list, for the types a run passes through (the arrival type of every step but the last). */
  readonly stopListed: ReadonlyMap<string, readonly string[]>;
  readonly windowed: boolean;
  /** A window is applied to at least one relationship the pattern reads: a windowed step crosses a row with a time property. Only then are relationships with no usable time left out. */
  readonly windowApplied: boolean;
  /** The relationship types of windowed steps that have a row with no time property, so that the window cannot apply to it. */
  readonly untimedTypes: readonly string[];
}

/**
 * What the request names, checked against the mapping: the anchor's and every arrival entity type, the relationship types and the rows that carry them in the stated direction, the conditions (each on a property the mapping declares
 * filterable), the windows and the stop-list of the types a run passes through. A name or a join the mapping does not have is refused without saying which.
 */
export function patternRequestOf(allowlist: SourceAllowlist, params: Params): PatternRequest {
  const parsed = z.object({ anchorType: z.string(), steps: stepsSchema }).safeParse(params);
  if (!parsed.success || !allowlist.entityLabels.has(parsed.data.anchorType)) throw new AppError('INVALID_REQUEST');
  const anchor = parsed.data.anchorType;
  let previous = anchor;
  const steps = parsed.data.steps.map((step): PatternStepRequest => {
    if (!allowlist.entityLabels.has(step.arrivesAt) || !step.relationshipTypes.every((type) => allowlist.relationshipTypes.has(type))) throw new AppError('INVALID_REQUEST');
    const branches = expandBranchesOf(allowlist, previous, step.arrivesAt, step.relationshipTypes, step.direction);
    if (!step.relationshipTypes.every((type) => branches.some((branch) => branch.type === type))) throw new AppError('INVALID_REQUEST');
    const conditions = step.conditions ?? [];
    if (undeclaredFilter(allowlist, step.arrivesAt, branches, conditions) !== undefined) throw new AppError('INVALID_REQUEST');
    const request: PatternStepRequest = { from: previous, arrivesAt: step.arrivesAt, branches, conditions, windowed: step.windowFrom !== undefined };
    previous = step.arrivesAt;
    return request;
  });
  const between = new Set(steps.slice(0, -1).map((step) => step.arrivesAt));
  const stopListed = new Map<string, readonly string[]>();
  for (const rule of allowlist.derivedRules ?? []) {
    if (rule.stopListProperty === undefined) continue;
    for (const middle of rule.via.filter((_entry, index) => index % 2 === 1)) {
      if (between.has(middle)) stopListed.set(middle, [...new Set([...(stopListed.get(middle) ?? []), rule.stopListProperty])]);
    }
  }
  const untimed = steps.filter((step) => step.windowed).flatMap((step) => step.branches.filter((branch) => branch.observedAt === undefined).map((branch) => branch.type));
  return { anchor, steps, stopListed, windowed: steps.some((step) => step.windowed), windowApplied: steps.some((step) => step.windowed && step.branches.some((branch) => branch.observedAt !== undefined)), untimedTypes: [...new Set(untimed)] };
}
