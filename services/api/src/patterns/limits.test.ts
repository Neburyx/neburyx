import { PATTERN_LIMITS } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { MAX_HOPS_CEILING } from '../mapping/budgets.js';

describe('the limits of a pattern', () => {
  it('hold as many steps as the API allows a source at most: the schema\'s cap is the ceiling of `max_hops`, and the source\'s own budget is the gate\'s at run time', () => {
    expect(PATTERN_LIMITS.steps).toBe(MAX_HOPS_CEILING);
  });
});
