import type { Question } from './questions.js';
import type { QuestionResult } from './run.js';

/** The demo set's target: every refusal refused and at most this many of the 25 plan questions missed (at least 23 right). */
export const DEMO_MAX_PLAN_MISSES = 2;

export interface Tally {
  readonly refusals: { readonly total: number; readonly refused: number; readonly missed: readonly string[] };
  readonly plans: { readonly total: number; readonly right: number; readonly missed: readonly string[] };
  readonly blocked: { readonly total: number; readonly blocked: number; readonly missed: readonly string[] };
  readonly repaired: number;
  readonly family: { readonly asked: number; readonly right: number; readonly measured: boolean };
}

export interface TargetOutcome {
  readonly refusalsMet: boolean;
  readonly plansMet: boolean;
  readonly blockedMet: boolean;
}

export function tally(questions: readonly Question[], results: readonly QuestionResult[]): Tally {
  const byId = new Map(questions.map((question) => [question.id, question] as const));
  const expected = results.filter((result) => byId.get(result.id)?.expect.kind === 'blocked');
  const refusals = results.filter((result) => byId.get(result.id)?.expect.kind === 'unsupported');
  const plans = results.filter((result) => byId.get(result.id)?.expect.kind === 'plan');
  const asked = refusals.filter((result) => {
    const expect = byId.get(result.id)?.expect;
    return expect?.kind === 'unsupported' && expect.family !== undefined && result.answered !== 'blocked';
  });
  const measured = refusals.some((result) => result.family !== undefined);
  return {
    refusals: { total: refusals.length, refused: refusals.filter((result) => result.verdict === 'refused').length, missed: refusals.filter((result) => result.verdict !== 'refused').map((result) => result.id) },
    plans: { total: plans.length, right: plans.filter((result) => result.verdict === 'right').length, missed: plans.filter((result) => result.verdict !== 'right').map((result) => result.id) },
    blocked: { total: expected.length, blocked: expected.filter((result) => result.verdict === 'blocked').length, missed: expected.filter((result) => result.verdict !== 'blocked').map((result) => result.id) },
    repaired: results.filter((result) => result.repaired).length,
    family: {
      asked: asked.length,
      right: asked.filter((result) => {
        const expect = byId.get(result.id)?.expect;
        return result.verdict === 'refused' && expect?.kind === 'unsupported' && result.family === expect.family;
      }).length,
      measured,
    },
  };
}

export function meetsTargets(found: Tally, maxPlanMisses: number): TargetOutcome {
  return { refusalsMet: found.refusals.missed.length === 0, plansMet: found.plans.missed.length <= maxPlanMisses, blockedMet: found.blocked.missed.length === 0 };
}
