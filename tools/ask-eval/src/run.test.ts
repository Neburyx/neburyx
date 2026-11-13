import { describe, expect, it } from 'vitest';
import { parseQuestions } from './questions.js';
import { summarize } from './report.js';
import { tally } from './targets.js';
import { DuplicateQuestionTextError, runQuestions } from './run.js';
import type { ScoreContext } from './score.js';
import type { PlannerAnswer, QuestionPlanner } from './types.js';

const CONTEXT: ScoreContext = { view: { types: [] }, defaultPage: 25 };

const FILE = `questions:
  - id: first
    wording: Show me ‹widget#1›.
    expect: { kind: plan, template: entity, params: { ref: { entityType: widget, stableId: ‹widget#1› } } }
  - id: second
    wording: Show me ‹widget#1›.
    expect: { kind: unsupported }
`;

function stub(answers: Readonly<Record<string, PlannerAnswer>>): QuestionPlanner {
  return { rebuild: (wording) => wording, answer: async (wording) => answers[wording] ?? { kind: 'no-reply', call: 'plan' } };
}

describe('running questions', () => {
  it('refuses two questions whose planner text is the same and names both ids', async () => {
    const run = runQuestions(parseQuestions(FILE), () => ({ planner: stub({}), context: CONTEXT }));
    await expect(run).rejects.toBeInstanceOf(DuplicateQuestionTextError);
    await expect(run).rejects.toThrow(/first and second/);
  });

  it('scores a refusal that got a plan as wrongly planned and lists it by id', async () => {
    const questions = parseQuestions(FILE.replace('wording: Show me ‹widget#1›.\n    expect: { kind: unsupported }', 'wording: Why ‹widget#1›?\n    expect: { kind: unsupported }'));
    const plan = { kind: 'plan', templateId: 'entity', templateVersion: 1, params: { ref: { entityType: 'widget', stableId: '‹widget#1›' } }, rationale: 'It names one.' } as const;
    const results = await runQuestions(questions, () => ({ context: CONTEXT, planner: stub({ 'Show me ‹widget#1›.': { kind: 'answered', plan, repaired: false }, 'Why ‹widget#1›?': { kind: 'answered', plan, repaired: false } }) }));
    expect(results.map((result) => result.verdict)).toEqual(['right', 'wrongly-planned']);
    const summary = summarize(tally(questions, results), results, 2, 'replay', undefined);
    expect(summary.lines).toContain('wrongly-planned: second');
    expect(summary.met).toBe(false);
  });
});
