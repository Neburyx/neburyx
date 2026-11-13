import { PATTERN_LIMITS } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { chainTitle, groupFull, hiddenInMenu, sourceProblems } from './copy.js';
import { stepLimitOf } from './model.js';

describe('the caps said as counts', () => {
  it('reads the chain as steps of the limit and conditions of the pattern’s limit, with the limits from the contract and the source', () => {
    expect(chainTitle(0, 4, 0)).toBe('Chain · no steps yet');
    expect(chainTitle(1, stepLimitOf(undefined), 0)).toBe(`Chain · 1 of ${PATTERN_LIMITS.steps} steps · 0 of ${PATTERN_LIMITS.conditionsPerPattern} conditions`);
    expect(chainTitle(4, 4, 21)).toBe('Chain · 4 of 4 steps · 21 of 24 conditions');
    expect(chainTitle(2, stepLimitOf(2), 3)).toBe('Chain · 2 of 2 steps · 3 of 24 conditions');
  });

  it('says a full group is full, with the cap from the contract', () => {
    expect(groupFull('Arriving Account')).toBe(`Arriving Account has ${PATTERN_LIMITS.conditionsPerElement} of ${PATTERN_LIMITS.conditionsPerElement}. Remove one to add another.`);
  });

  it('counts problems and hidden properties with the right number word', () => {
    expect(sourceProblems(1)).toBe('1 problem from the source. Preview is off.');
    expect(sourceProblems(2)).toBe('2 problems from the source. Preview is off.');
    expect(hiddenInMenu(1)).toBe('1 personal-data property hidden (masking on)');
    expect(hiddenInMenu(2)).toBe('2 personal-data properties hidden (masking on)');
  });
});
