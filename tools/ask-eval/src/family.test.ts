import { ASK_REFUSAL_FAMILIES } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { REFUSAL_FAMILIES } from './families.js';
import { parseQuestions } from './questions.js';
import type { QuestionResult } from './run.js';
import { tally } from './targets.js';

const questions = parseQuestions(`questions:
  - id: one
    wording: Is ‹widget#1› fraudulent?
    expect: { kind: unsupported, family: judgement }
  - id: two
    wording: Which of these has the most?
    expect: { kind: unsupported, family: loaded-view }
  - id: three
    wording: Which widgets are related to ‹widget#1›?
    expect: { kind: unsupported }
`);
const refused = (id: string, family?: string): QuestionResult => ({ id, verdict: 'refused', fields: [], repaired: false, answered: 'unsupported', ...(family === undefined ? {} : { family }) });

describe('the family count', () => {
  it('counts a refusal whose family is the expected one and not one that has another, and leaves an entry with no expected family out', () => {
    const found = tally(questions, [refused('one', 'judgement'), refused('two', 'other'), refused('three', 'path')]);
    expect(found.family).toEqual({ asked: 2, right: 1, measured: true });
    expect(found.refusals.refused).toBe(3);
  });

  it('is not measured when no answer carries a family', () => {
    expect(tally(questions, [refused('one'), refused('two'), refused('three')]).family.measured).toBe(false);
  });

  it('does not count a refusal that was not refused, even when the family field is there', () => {
    const found = tally(questions, [{ id: 'one', verdict: 'wrongly-planned', fields: [], repaired: false, answered: 'plan', family: 'judgement' }, refused('two', 'loaded-view'), refused('three')]);
    expect(found.family.right).toBe(1);
  });
});

describe('the families of the question file', () => {
  it('are the families of the closed list of the contracts that the model may name, and no other', () => {
    expect([...REFUSAL_FAMILIES].sort()).toEqual(ASK_REFUSAL_FAMILIES.filter((family) => family !== 'plan-not-usable' && family !== 'model-refused').sort());
  });
});
