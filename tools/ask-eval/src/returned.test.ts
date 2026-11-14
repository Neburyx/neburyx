import { describe, expect, it } from 'vitest';
import { groupLines, groupReport, reportSchema } from './groups.js';
import { parseQuestions } from './questions.js';
import type { QuestionResult } from './run.js';
import { summarize } from './report.js';
import { tally } from './targets.js';

const questions = parseQuestions(`questions:
  - id: asks-for-plan
    wording: Show me ‹widget#1›.
    expect: { kind: plan, template: entity, params: { ref: { entityType: widget, stableId: ‹widget#1› } } }
  - id: asks-for-plan-two
    wording: Show me ‹widget#2›.
    expect: { kind: plan, template: entity, params: { ref: { entityType: widget, stableId: ‹widget#2› } } }
  - id: judgement
    wording: Is ‹widget#1› fraudulent?
    expect: { kind: unsupported }
  - id: blocked-one
    wording: Show me zzxqvk.
    expect: { kind: blocked }
`);

const result = (id: string, answered: QuestionResult['answered'], verdict: string, family?: string): QuestionResult => ({ id, verdict: verdict as QuestionResult['verdict'], fields: [], repaired: false, answered, ...(family === undefined ? {} : { family }) });
const reportOf = (results: readonly QuestionResult[]) => groupReport(questions, results, summarize(tally(questions, results), results, 2, 'replay', undefined).data);

describe('the rate by the family the planner returned', () => {
  it('counts a plan, each family a refusal carries, and a missing reply, and leaves a blocked question out', () => {
    const report = reportOf([result('asks-for-plan', 'plan', 'right'), result('asks-for-plan-two', 'unsupported', 'wrong-answer', 'plan-not-usable'), result('judgement', 'unsupported', 'refused', 'judgement'), result('blocked-one', 'blocked', 'blocked')]);
    expect(report.byReturned).toEqual({ measured: true, counts: [{ answer: 'judgement', count: 1 }, { answer: 'plan', count: 1 }, { answer: 'plan-not-usable', count: 1 }] });
    expect(groupLines(report)).toEqual(expect.arrayContaining(['returned judgement: 1', 'returned plan: 1', 'returned plan-not-usable: 1']));
    expect(reportSchema.safeParse(report).success).toBe(true);
  });

  it('counts a plan question that came back as a refusal by its returned family, beside its template count', () => {
    const report = reportOf([result('asks-for-plan', 'unsupported', 'wrongly-planned', 'attribute-combination'), result('asks-for-plan-two', 'plan', 'right')]);
    expect(report.byReturned.counts).toEqual([{ answer: 'attribute-combination', count: 1 }, { answer: 'plan', count: 1 }]);
    expect(report.byTemplate).toEqual([{ template: 'entity', right: 1, wrong: 0, refused: 1 }]);
  });

  it('counts a question with no reply as no-reply', () => {
    expect(reportOf([result('asks-for-plan', 'no-reply', 'no-reply')]).byReturned.counts).toEqual([{ answer: 'no-reply', count: 1 }]);
  });

  it('says the family was not measured when refusals carry none, and prints counts only', () => {
    const report = reportOf([result('judgement', 'unsupported', 'refused')]);
    expect(report.byReturned.measured).toBe(false);
    const lines = groupLines(report);
    expect(lines).toContain('returned family: not measured');
    expect(lines.join('\n')).not.toContain('fraudulent');
  });

  it('holds only counts and family names in the json, never a wording', () => {
    const text = JSON.stringify(reportOf([result('judgement', 'unsupported', 'refused', 'judgement')]).byReturned);
    expect(text).toBe('{"measured":true,"counts":[{"answer":"judgement","count":1}]}');
  });
});
