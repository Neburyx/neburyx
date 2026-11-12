import type { Count } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { degreeCountText } from './degree-text.js';
import { remainderLine } from './scope-text.js';

describe('the text of a lower bound', () => {
  const lowerBound = (value: number): Count => ({ value, quality: 'lowerBound', scope: 'degree:out:LINKED:mapped-relationship-ends' });

  it('reads a count of the cap as "≥ 500 · lower bound"', () => {
    expect(degreeCountText(lowerBound(500))).toBe('≥ 500 · lower bound');
  });

  it('reads the part of a lower bound that is not yet retrieved with its quality', () => {
    expect(remainderLine(25, { count: lowerBound(475), uncounted: 0 })).toBe('25 shown · ≥ 475 not yet retrieved (lower bound)');
  });

  it('shows no number for an unknown count', () => {
    expect(degreeCountText({ quality: 'unknown', scope: 'x' })).toBe('no count');
  });
});
