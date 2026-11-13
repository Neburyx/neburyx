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
}

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

function scorePlanAnswer(expect: Extract<Expectation, { kind: 'plan' }>, plan: AskPlan, context: ScoreContext): Score {
  if (plan.kind !== 'plan') return { verdict: 'wrong', fields: NO_FIELDS };
  if (plan.templateId !== expect.template) return { verdict: 'wrong', fields: ['template'] };
  const expected = normalize(expect.template, expect.params, context);
  const actual = normalize(plan.templateId, plan.params, context);
  if (expected === undefined || actual === undefined) return { verdict: 'wrong', fields: ['direction-underivable'] };
  const fields = differing(expected, actual);
  return { verdict: fields.length === 0 ? 'right' : 'wrong', fields };
}

export function scorePlan(expect: Expectation, answer: PlannerAnswer, context: ScoreContext): Score {
  if (answer.kind === 'no-reply') return { verdict: expect.kind === 'blocked' ? 'not-blocked' : 'no-reply', fields: NO_FIELDS };
  if (answer.kind === 'blocked') return { verdict: expect.kind === 'blocked' ? 'blocked' : 'blocked-unexpectedly', fields: NO_FIELDS };
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
