import { isDeepStrictEqual } from 'node:util';
import { askPlanSchema, type AiMappingView, type AskPlan } from '@neburyx/contracts';
import { ASK_EVAL_DEFAULTS } from './defaults.js';
import type { Expectation } from './questions.js';
import type { PlannerAnswer } from './types.js';

export const VERDICTS = ['right', 'wrong', 'refused', 'wrongly-planned', 'blocked', 'blocked-unexpectedly', 'not-blocked', 'no-reply'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ScoreContext {
  readonly view: AiMappingView;
  readonly defaultPage: number;
}

export interface Score {
  readonly verdict: Verdict;
  readonly fields: readonly string[];
  /** Set when the plan is right by a named rule of equivalence and not by being the expected template. */
  readonly rule?: typeof ONE_HOP_RULE | typeof BLOCKED_REFUSAL_RULE;
}

/** The name of the rule that counts `expand` and `linked-entities` as the same plan for one neighbor type over one relationship type (see `oneHopForm`). */
export const ONE_HOP_RULE = 'one-hop-neighbors';

/** The name of the rule that counts a question that is expected to be refused and that the allowlist blocks before planning as refused: nothing was sent to the model and the investigator is told the question cannot be asked. */
export const BLOCKED_REFUSAL_RULE = 'blocked-before-planning';

type Params = Readonly<Record<string, unknown>>;
type Direction = 'out' | 'in' | 'both';

const SET_FIELDS = ['relTypes', 'neighborTypes', 'entityTypes', 'via'] as const;
const NO_FIELDS: readonly string[] = [];

function sortedSet(value: unknown): unknown {
  return Array.isArray(value) ? [...value].map(String).sort() : value;
}

function directionFrom(view: AiMappingView, anchorType: unknown, via: unknown): Direction | undefined {
  const names = new Set(Array.isArray(via) ? via.map(String) : [String(via)]);
  const found = new Set<Direction>();
  for (const type of view.types) {
    if (type.kind !== 'relationship' || !names.has(type.name)) continue;
    for (const end of type.ends ?? []) {
      if (end.from === anchorType) found.add('out');
      else if (end.to === anchorType) found.add('in');
    }
  }
  const [only] = [...found];
  return found.size === 1 ? only : undefined;
}

function anchorTypeOf(params: Params): unknown {
  const { ref } = params;
  return typeof ref === 'object' && ref !== null ? Reflect.get(ref, 'entityType') : undefined;
}

function orderedEnds(params: Params, view: AiMappingView): unknown {
  const { ends, ruleId } = params;
  const rule = view.derivedRules?.find((candidate) => candidate.id === ruleId);
  if (!Array.isArray(ends) || rule === undefined || rule.from !== rule.to) return ends;
  return [...ends].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

/** The parameters of a plan with every default filled in; undefined when the direction of a linked-entities plan cannot be derived. */
export function normalize(template: string, params: Params, context: ScoreContext): Params | undefined {
  const filled: Record<string, unknown> = { ...params };
  for (const field of SET_FIELDS) if (field in filled) filled[field] = sortedSet(filled[field]);
  switch (template) {
    case 'shared-attribute':
      filled['minShared'] ??= ASK_EVAL_DEFAULTS.minShared;
      filled['limit'] ??= context.defaultPage;
      break;
    case 'linked-entities': {
      filled['maxHops'] ??= ASK_EVAL_DEFAULTS.maxHops;
      filled['limit'] ??= context.defaultPage;
      filled['direction'] ??= directionFrom(context.view, anchorTypeOf(params), params['via']);
      if (filled['direction'] === undefined) return undefined;
      break;
    }
    case 'expand':
      filled['direction'] ??= ASK_EVAL_DEFAULTS.expandDirection;
      filled['sort'] ??= ASK_EVAL_DEFAULTS.expandSort;
      filled['limit'] ??= context.defaultPage;
      break;
    case 'derived-edge-support':
      filled['ends'] = orderedEnds(params, context.view);
      break;
    default:
      break;
  }
  return filled;
}

function differing(left: Params, right: Params): readonly string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((key) => !isDeepStrictEqual(left[key], right[key])).sort();
}

/**
 * The one-hop rule. An `expand` plan and a `linked-entities` plan are the same plan when each reads as: the entities of one target type at the other end of one relationship type from the anchor,
 * in one direction, with the same window and limit. For `linked-entities` that is one relationship type in `via`, `maxHops` 1 after the default and a direction given or derived from the mapping; for `expand` it is
 * one relationship type in `relTypes`, one type in `neighborTypes`, the direction (`both` when it is omitted), the default sort and no rank, filter or cursor. Anything else (two hops, two relationship types, another
 * direction or target type, another window or limit, a sort or a rank) has no such form and is a different plan.
 */
export function oneHopForm(template: string, params: Params, context: ScoreContext): Params | undefined {
  const filled = normalize(template, params, context);
  if (filled === undefined) return undefined;
  const single = (value: unknown): unknown => (Array.isArray(value) && value.length === 1 ? value[0] : undefined);
  if (template === 'linked-entities') {
    const via = single(filled['via']);
    if (via === undefined || filled['maxHops'] !== 1) return undefined;
    return { ref: filled['ref'], relationship: via, direction: filled['direction'], target: filled['targetType'], window: filled['window'], limit: filled['limit'] };
  }
  if (template === 'expand') {
    const relationship = single(filled['relTypes']);
    const target = single(filled['neighborTypes']);
    if (relationship === undefined || target === undefined) return undefined;
    if (filled['sort'] !== ASK_EVAL_DEFAULTS.expandSort || 'rank' in filled || 'filters' in filled || 'cursors' in filled) return undefined;
    return { ref: filled['ref'], relationship, direction: filled['direction'], target, window: filled['window'], limit: filled['limit'] };
  }
  return undefined;
}

function scorePlanAnswer(expect: Extract<Expectation, { kind: 'plan' }>, plan: AskPlan, context: ScoreContext): Score {
  if (plan.kind !== 'plan') return { verdict: 'wrong', fields: NO_FIELDS };
  if (plan.templateId !== expect.template) {
    const wanted = oneHopForm(expect.template, expect.params, context);
    const given = oneHopForm(plan.templateId, plan.params, context);
    if (wanted !== undefined && given !== undefined && isDeepStrictEqual(wanted, given)) return { verdict: 'right', fields: NO_FIELDS, rule: ONE_HOP_RULE };
    return { verdict: 'wrong', fields: ['template'] };
  }
  const expected = normalize(expect.template, expect.params, context);
  const actual = normalize(plan.templateId, plan.params, context);
  if (expected === undefined || actual === undefined) return { verdict: 'wrong', fields: ['direction-underivable'] };
  const fields = differing(expected, actual);
  return { verdict: fields.length === 0 ? 'right' : 'wrong', fields };
}

export function scorePlan(expect: Expectation, answer: PlannerAnswer, context: ScoreContext): Score {
  if (answer.kind === 'no-reply') return { verdict: expect.kind === 'blocked' ? 'not-blocked' : 'no-reply', fields: NO_FIELDS };
  if (answer.kind === 'blocked') {
    if (expect.kind === 'unsupported') return { verdict: 'refused', fields: NO_FIELDS, rule: BLOCKED_REFUSAL_RULE };
    return { verdict: expect.kind === 'blocked' ? 'blocked' : 'blocked-unexpectedly', fields: NO_FIELDS };
  }
  const { plan } = answer;
  if (!askPlanSchema.safeParse(plan).success) return { verdict: 'wrong', fields: NO_FIELDS };
  switch (expect.kind) {
    case 'plan':
      return scorePlanAnswer(expect, plan, context);
    case 'unsupported':
      return { verdict: plan.kind === 'unsupported' ? 'refused' : 'wrongly-planned', fields: NO_FIELDS };
    case 'blocked':
      return { verdict: 'not-blocked', fields: NO_FIELDS };
    default: {
      const unreachable: never = expect;
      return unreachable;
    }
  }
}
