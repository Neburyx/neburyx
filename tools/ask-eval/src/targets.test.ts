import { describe, expect, it } from 'vitest';
import { parseQuestions } from './questions.js';
import type { QuestionResult } from './run.js';
import { meetsTargets, tally } from './targets.js';

const entry = (id: string, expect: string) => `  - id: ${id}\n    wording: Show me ‹widget#1› ${id}.\n    expect: ${expect}\n`;
const PLAN = '{ kind: plan, template: entity, params: { ref: { entityType: widget, stableId: ‹widget#1› } } }';
const questions = parseQuestions(`questions:\n${['a', 'b', 'c', 'd'].map((id) => entry(id, PLAN)).join('')}${entry('r', '{ kind: unsupported }')}`);
const result = (id: string, verdict: QuestionResult['verdict']): QuestionResult => ({ id, verdict, fields: [], repaired: false, answered: 'plan' });

describe('the targets', () => {
  it('are met by every refusal refused and the plan misses within the allowed number', () => {
    const found = tally(questions, [result('a', 'right'), result('b', 'right'), result('c', 'wrong'), result('d', 'no-reply'), result('r', 'refused')]);
    expect(meetsTargets(found, 2)).toEqual({ refusalsMet: true, plansMet: true, blockedMet: true });
  });

  it('are missed by a refusal question that got a plan, whatever the plans scored', () => {
    const found = tally(questions, [result('a', 'right'), result('b', 'right'), result('c', 'right'), result('d', 'right'), result('r', 'wrongly-planned')]);
    expect(found.refusals.missed).toEqual(['r']);
    expect(meetsTargets(found, 2).refusalsMet).toBe(false);
  });

  it('are missed by one plan miss more than allowed, and a blocked question that was not expected to block counts as a miss', () => {
    const found = tally(questions, [result('a', 'right'), result('b', 'blocked-unexpectedly'), result('c', 'wrong'), result('d', 'wrong'), result('r', 'refused')]);
    expect(found.plans.missed).toEqual(['b', 'c', 'd']);
    expect(meetsTargets(found, 2).plansMet).toBe(false);
    expect(meetsTargets(found, 3).plansMet).toBe(true);
  });
});
