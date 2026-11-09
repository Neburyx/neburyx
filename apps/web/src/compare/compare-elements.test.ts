import { describe, expect, it } from 'vitest';
import { titleHoldsReference } from './compare-elements.js';

describe('a title that holds its reference', () => {
  it.each([
    ['Account 110057:803A12250', '110057:803A12250', true],
    ['Title n1', 'n1', true],
    ['n1', 'n1', true],
    ['Jordan (n1)', 'n1', true],
    ['Title n10', 'n1', false],
    ['Customer 12', '1', false],
    ['Jordan', 'n2', false],
    ['Price a+b', 'a+b', true],
    ['Price axb', 'a+b', false],
  ])('%s holds %s: %s', (title, reference, expected) => {
    expect(titleHoldsReference(title, reference)).toBe(expected);
  });
});
