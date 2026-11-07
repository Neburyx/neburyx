import { describe, expect, it } from 'vitest';
import { checkBuilt } from './fixture.js';

const right = { linked: 1000, tied: 1000, noted: 1000, paid: 1000, neighbors: 1000, uneven: 0 };

describe('the check of what the benchmark built', () => {
  it('accepts the counts of the plan', () => {
    expect(() => checkBuilt(1000, right)).not.toThrow();
  });

  it('refuses a count that is not the plan\'s', () => {
    expect(() => checkBuilt(1000, { ...right, tied: 999 })).toThrow('instead of');
    expect(() => checkBuilt(1000, { ...right, neighbors: 1001 })).toThrow('instead of');
  });

  it('refuses an aggregate neighbor that does not hold ten members', () => {
    expect(() => checkBuilt(1000, { ...right, uneven: 3 })).toThrow('3 aggregate neighbors');
  });
});
