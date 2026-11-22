import { describe, expect, it } from 'vitest';
import { groupThousands, rangeText } from './range-text.js';

describe('thousands separators', () => {
  it('are put into the integer digits of the text, so nothing is rounded', () => {
    expect(groupThousands('1000')).toBe('1,000');
    expect(groupThousands('999')).toBe('999');
    expect(groupThousands('-1234567.891')).toBe('-1,234,567.891');
    expect(groupThousands('9007199254740993')).toBe('9,007,199,254,740,993');
    expect(groupThousands('0.0000001')).toBe('0.0000001');
    expect(groupThousands('+5000')).toBe('5,000');
  });

  it('leave text that is not decimal as it is', () => {
    expect(groupThousands('2026-03-01')).toBe('2026-03-01');
  });
});

describe('the closed text of a range', () => {
  it('is the bounds joined by an en dash, an open end as at least or at most, and Any with none', () => {
    expect(rangeText('number', '1000', '5000')).toBe('1,000–5,000');
    expect(rangeText('number', '1000', undefined)).toBe('≥ 1,000');
    expect(rangeText('number', undefined, '5000')).toBe('≤ 5,000');
    expect(rangeText('number', undefined, undefined)).toBe('Any');
    expect(rangeText('date', '2026-10-21', '2026-10-28')).toBe('2026-10-21–2026-10-28');
  });
});
