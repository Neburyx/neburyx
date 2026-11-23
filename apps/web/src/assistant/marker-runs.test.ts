import { describe, expect, it } from 'vitest';
import type { CitationEntry } from '../summary/summary-model.js';
import { markerGroups } from './marker-runs.js';

const entry = (number: number): CitationEntry => ({ key: `k${number}`, number, kind: 'entity', graphKey: `g${number}`, label: `label ${number}` });
const shape = (numbers: readonly number[]): string[] =>
  markerGroups(numbers.map(entry), true).map((group) => (group.kind === 'run' ? `${group.first.number}-${group.last.number}` : `${group.entry.number}`));

describe('markerGroups', () => {
  it('draws every number alone when no list is there for a range to open', () => {
    expect(markerGroups([1, 2, 3, 4].map(entry), false).map((group) => group.kind)).toEqual(['single', 'single', 'single', 'single']);
  });

  it.each([
    [[1], ['1']],
    [[1, 2], ['1', '2']],
    [[1, 2, 3], ['1-3']],
    [[3, 4, 5, 6, 9], ['3-6', '9']],
    [[3, 4, 3], ['3', '4', '3']],
    [[1, 2, 3, 2], ['1-3', '2']],
    [[5, 3, 4], ['5', '3', '4']],
    [[], []],
  ])('draws %j as %j', (numbers, expected) => {
    expect(shape(numbers)).toEqual(expected);
  });
});
