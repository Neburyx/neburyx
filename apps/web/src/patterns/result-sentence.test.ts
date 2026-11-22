import { describe, expect, it } from 'vitest';
import { resultSentence } from './copy.js';

const exact = (value: number) => ({ value, quality: 'exact' as const, scope: 'matches' as const });

describe('the sentence of a result', () => {
  it.each([
    ['account', '2 other accounts found · exact'],
    ['policy', '2 other policies found · exact'],
    ['branch', '2 other branches found · exact'],
    ['address', '2 other addresses found · exact'],
  ])('writes the plural of the type %s', (noun, text) => {
    expect(resultSentence(exact(2), false, false, noun, undefined)).toBe(text);
  });

  it('keeps the singular for one exact match, the time when it is known, and the plural for a bound of one', () => {
    expect(resultSentence(exact(1), false, false, 'account', 380)).toBe('1 other account found · exact · 0.38 s');
    expect(resultSentence({ value: 1, quality: 'lowerBound', scope: 'matches' }, false, true, 'account', undefined)).toBe('≥ 1 accounts reached · lower bound');
  });
});
