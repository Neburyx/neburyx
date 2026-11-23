import { describe, expect, it } from 'vitest';
import { resultSentence } from './copy.js';

const exact = (value: number) => ({ value, quality: 'exact' as const, scope: 'matches' as const });

describe('the sentence of a result', () => {
  it.each([
    ['node', '2 other nodes found · exact'],
    ['entry', '2 other entries found · exact'],
    ['batch', '2 other batches found · exact'],
    ['class', '2 other classes found · exact'],
  ])('writes the plural of the type %s', (noun, text) => {
    expect(resultSentence(exact(2), false, false, noun, undefined)).toBe(text);
  });

  it('keeps the singular for one exact match, the time when it is known, and the plural for a bound of one', () => {
    expect(resultSentence(exact(1), false, false, 'node', 380)).toBe('1 other node found · exact · 0.38\u00a0s');
    expect(resultSentence({ value: 1, quality: 'lowerBound', scope: 'matches' }, false, true, 'node', undefined)).toBe('≥ 1 nodes reached · lower bound');
  });
});
