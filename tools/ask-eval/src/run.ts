import type { Question } from './questions.js';
import { scorePlan, type ScoreContext, type Verdict } from './score.js';
import type { PlannerAnswer, QuestionPlanner } from './types.js';

export interface Target {
  readonly planner: QuestionPlanner;
  readonly context: ScoreContext;
}

export interface QuestionResult {
  readonly id: string;
  readonly verdict: Verdict;
  readonly fields: readonly string[];
  readonly repaired: boolean;
  readonly family?: string;
  readonly answered: 'plan' | 'unsupported' | 'blocked' | 'no-reply';
}

function answeredOf(answer: PlannerAnswer): QuestionResult['answered'] {
  if (answer.kind === 'answered') return answer.plan.kind === 'plan' ? 'plan' : 'unsupported';
  return answer.kind;
}

function familyOf(answer: PlannerAnswer): { readonly family?: string } {
  if (answer.kind !== 'answered' || answer.plan.kind !== 'unsupported') return {};
  const family: unknown = Reflect.get(answer.plan, 'family');
  return typeof family === 'string' ? { family } : {};
}

export class DuplicateQuestionTextError extends Error {}

function refuseEqualTexts(questions: readonly Question[], targetOf: (question: Question) => Target): void {
  const owner = new Map<string, string>();
  for (const question of questions) {
    const text = targetOf(question).planner.rebuild(question.wording);
    if (text === undefined) continue;
    const first = owner.get(text);
    if (first !== undefined) throw new DuplicateQuestionTextError(`the questions ${first} and ${question.id} give the planner the same text`);
    owner.set(text, question.id);
  }
}

export async function runQuestions(questions: readonly Question[], targetOf: (question: Question) => Target): Promise<readonly QuestionResult[]> {
  refuseEqualTexts(questions, targetOf);
  const results: QuestionResult[] = [];
  for (const question of questions) {
    const target = targetOf(question);
    const answer = await target.planner.answer(question.wording);
    const score = scorePlan(question.expect, answer, target.context);
    results.push({ id: question.id, verdict: score.verdict, fields: score.fields, repaired: answer.kind === 'answered' && answer.repaired, answered: answeredOf(answer), ...familyOf(answer) });
  }
  return results;
}
