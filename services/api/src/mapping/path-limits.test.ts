import { PATHS_HOPS_MAX, PATHS_RESULTS_MAX } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { MAX_HOPS_CEILING, PATH_RESULTS_CEILING } from './budgets.js';

describe('the limits of a path search in the contracts', () => {
  it('are the ceilings of the source budgets max_hops and path_results_cap, which an Ask intent is held to at start-up', () => {
    expect(PATHS_HOPS_MAX).toBe(MAX_HOPS_CEILING);
    expect(PATHS_RESULTS_MAX).toBe(PATH_RESULTS_CEILING);
  });
});
