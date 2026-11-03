import { describe, expect, it } from 'vitest';
import { countSchema } from '@neburyx/contracts';
import { countOf, unknownCount } from './count.js';

describe('a count', () => {
  it.each([[0], [1], [25], [Number.MAX_SAFE_INTEGER]])('of %s is built with the quality it is given and a scope', (value) => {
    expect(countOf(value, 'exact', 'members')).toEqual({ value, quality: 'exact', scope: 'members' });
    expect(countOf(value, 'lowerBound', 'members')).toEqual({ value, quality: 'lowerBound', scope: 'members' });
    expect(countOf(value, 'estimated', 'members')).toEqual({ value, quality: 'estimated', scope: 'members' });
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a negative', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['a number beyond the safe range', 2 ** 53],
    ['a tagged integer', { $type: 'integer', value: '9223372036854775807' }],
    ['text', '3'],
    ['a list', [1]],
  ])('with %s is unknown, with no value at all', (_name, value) => {
    const count = countOf(value, 'exact', 'members');
    expect(count).toEqual({ quality: 'unknown', scope: 'members' });
    expect('value' in count).toBe(false);
  });

  it('is always a valid Count of the contract', () => {
    for (const value of [0, 3, -1, Number.NaN, undefined]) expect(countSchema.safeParse(countOf(value, 'lowerBound', 's')).success).toBe(true);
    expect(countSchema.safeParse(unknownCount('s')).success).toBe(true);
  });
});
