import type { Count, DegreeByType } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { sumOf } from './degree-sum.js';
import { neighborCountsOf } from './neighbor-counts.js';

const count = (value: number | undefined, quality: Count['quality'] = 'exact'): Count => (value === undefined ? { quality: 'unknown', scope: 'x' } : { value, quality, scope: 'x' });
const pair = (relationshipType: string, direction: 'out' | 'in', counted: Count, neighborTypes: string[]): DegreeByType => ({ relationshipType, direction, count: counted, neighborTypes });
const scopeOf = (type: string) => `degree:neighbor:${type}:mapped-relationship-ends`;

describe('the counts by neighbor type', () => {
  it('gives a neighbor type the count of the one pair that reaches it', () => {
    expect(neighborCountsOf([pair('LINKS', 'out', count(12), ['kind-a'])])).toEqual([{ entityType: 'kind-a', count: { value: 12, quality: 'exact', scope: scopeOf('kind-a') } }]);
  });

  it('gives each neighbor type of a pair with several `unknown` and keeps no value for it', () => {
    expect(neighborCountsOf([pair('LINKS', 'out', count(12), ['kind-a', 'kind-b'])])).toEqual([
      { entityType: 'kind-a', count: { quality: 'unknown', scope: scopeOf('kind-a') } },
      { entityType: 'kind-b', count: { quality: 'unknown', scope: scopeOf('kind-b') } },
    ]);
  });

  it('adds the pairs that reach one neighbor type, with the weakest quality of the parts', () => {
    const exact = neighborCountsOf([pair('A', 'out', count(2), ['kind-a']), pair('B', 'in', count(3), ['kind-a'])]);
    expect(exact).toEqual([{ entityType: 'kind-a', count: { value: 5, quality: 'exact', scope: scopeOf('kind-a') } }]);
    const capped = neighborCountsOf([pair('A', 'out', count(2), ['kind-a']), pair('B', 'in', count(500, 'lowerBound'), ['kind-a'])]);
    expect(capped).toEqual([{ entityType: 'kind-a', count: { value: 502, quality: 'lowerBound', scope: scopeOf('kind-a') } }]);
  });

  it('is unknown when a part is unknown, and when a sum would pass the largest safe integer', () => {
    expect(neighborCountsOf([pair('A', 'out', count(2), ['kind-a']), pair('B', 'in', count(undefined), ['kind-a'])])[0]?.count).toEqual({ quality: 'unknown', scope: scopeOf('kind-a') });
    expect(neighborCountsOf([pair('A', 'out', count(Number.MAX_SAFE_INTEGER), ['kind-a']), pair('B', 'in', count(1), ['kind-a'])])[0]?.count).toEqual({ quality: 'unknown', scope: scopeOf('kind-a') });
  });

  it('lists each neighbor type once, in the order the pairs name them', () => {
    const types = neighborCountsOf([pair('A', 'out', count(1), ['kind-b', 'kind-a']), pair('B', 'in', count(1), ['kind-a']), pair('C', 'out', count(1), ['kind-c'])]).map((entry) => entry.entityType);
    expect(types).toEqual(['kind-b', 'kind-a', 'kind-c']);
  });

  it('lists nothing for no pair', () => {
    expect(neighborCountsOf([])).toEqual([]);
  });
});

describe('the sum of counts', () => {
  it('is an exact zero for no count', () => {
    expect(sumOf([], 's')).toEqual({ value: 0, quality: 'exact', scope: 's' });
  });
});
