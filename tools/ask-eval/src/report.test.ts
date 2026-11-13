import { describe, expect, it } from 'vitest';
import { groupLines, groupReport, reportSchema, type Report } from './groups.js';
import { parseQuestions } from './questions.js';
import { summarize } from './report.js';
import type { QuestionResult } from './run.js';
import { tally } from './targets.js';

const PLAN = '{ kind: plan, template: entity, params: { ref: { entityType: widget, stableId: ‹widget#1› } } }';
const questions = parseQuestions(`questions:
  - id: plan-one
    wording: Show me ‹widget#1› secret-wording.
    expect: ${PLAN}
  - id: plan-two
    wording: Show ‹widget#1› again.
    expect: ${PLAN}
  - id: refuse-one
    wording: Is ‹widget#1› fraudulent?
    expect: { kind: unsupported, family: judgement }
  - id: refuse-two
    wording: Which of these is it?
    expect: { kind: unsupported, family: loaded-view }
  - id: refuse-three
    wording: Which widgets are related to ‹widget#1›?
    expect: { kind: unsupported }
`);
const result = (id: string, verdict: QuestionResult['verdict'], answered: QuestionResult['answered']): QuestionResult => ({ id, verdict, fields: [], repaired: false, answered });
const results = [result('plan-one', 'right', 'plan'), result('plan-two', 'wrong', 'unsupported'), result('refuse-one', 'refused', 'unsupported'), result('refuse-two', 'wrongly-planned', 'plan'), result('refuse-three', 'refused', 'unsupported')];

const reportOf = (): Report => groupReport(questions, results, summarize(tally(questions, results), results, 2, 'replay', undefined).data);

describe('the grouped report', () => {
  it('counts the refusals by expected family, with the entries that have none under unspecified, and the plans by expected template', () => {
    const report = reportOf();
    expect(report.byFamily).toEqual([
      { family: 'judgement', refused: 1, wronglyPlanned: 0, other: 0 },
      { family: 'loaded-view', refused: 0, wronglyPlanned: 1, other: 0 },
      { family: 'unspecified', refused: 1, wronglyPlanned: 0, other: 0 },
    ]);
    expect(report.byTemplate).toEqual([{ template: 'entity', right: 1, wrong: 0, refused: 1 }]);
  });

  it('gives the overall refusal rate as a count over a total, and lists no group without a question', () => {
    const report = reportOf();
    expect(report.overall).toEqual({ total: 5, answeredUnsupported: 3, blocked: 0 });
    const lines = groupLines(report);
    expect(lines[0]).toBe('answered unsupported: 3 of 5');
    expect(lines.join('\n')).not.toContain('%');
    expect(lines.some((line) => line.startsWith('template expand'))).toBe(false);
  });

  it('is one document that fits its schema, holds the targets, the baseline and the counts as well as the groups, and never a wording', () => {
    const report = reportOf();
    expect(reportSchema.safeParse(report).success).toBe(true);
    expect(report.summary).toMatchObject({ refusals: { total: 3, refused: 2 }, plans: { total: 2, right: 1, maxMisses: 2 }, targets: { refusalsMet: false, plansMet: true, blockedMet: true }, baseline: { mode: 'replay', value: null, missed: false } });
    const text = JSON.stringify(report);
    expect(text).not.toContain('secret-wording');
    expect(text).not.toContain('fraudulent');
    expect(groupLines(report).join('\n')).not.toContain('secret-wording');
  });
});
