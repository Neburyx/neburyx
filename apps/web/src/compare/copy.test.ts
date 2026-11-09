import { describe, expect, it } from 'vitest';
import * as copy from './copy.js';

describe('the words of the comparison', () => {
  it('say "relationship" and never "edge"', () => {
    const texts = [...Object.values(copy).flatMap((value) => (typeof value === 'string' ? [value] : [])), copy.compareLabel(5, 7), copy.comparingLine(5, 7), copy.removedNote('SENT'), copy.rowsLine(1, 2)];
    for (const text of texts) expect(text, text).not.toMatch(/\bedges?\b/i);
  });

  it('say how many are compared, and name a removal', () => {
    expect(copy.compareLabel(5, 5)).toBe('Compare');
    expect(copy.compareLabel(5, 7)).toBe('Compare 5 of 7');
    expect(copy.comparingLine(5, 7)).toBe('Comparing 5 of the 7 selected when opened');
    expect(copy.comparingLine(3, 3)).toBe('Comparing 3');
    expect(copy.removedNote('SENT')).toBe('SENT was removed from the view and is no longer compared');
    expect(copy.rowsLine(1, 2)).toBe('Showing 1 of 2 rows');
  });
});
