import type { Count } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { formatNumber, loadedLine, remainderLine, UNKNOWN_REMAINDER } from './scope-text.js';

const exact = (value: number): Count => ({ value, quality: 'exact', scope: 'loaded in this view' });
const graph = (entities: Count, relationships: Count): LoadedGraph => ({ nodes: [], edges: [], entities, relationships });

describe('the loaded line', () => {
  it('reads the counts with "loaded · exact"', () => {
    expect(loadedLine(graph(exact(10), exact(13)))).toBe('10 entities · 13 relationships · loaded · exact');
  });

  it('uses the singular for one, and zero is plural', () => {
    expect(loadedLine(graph(exact(1), exact(1)))).toBe('1 entity · 1 relationship · loaded · exact');
    expect(loadedLine(graph(exact(0), exact(0)))).toBe('0 entities · 0 relationships · loaded · exact');
  });

  it('names the weaker quality when the two differ, and prints no number for an unknown count', () => {
    expect(loadedLine(graph(exact(5), { value: 7, quality: 'lowerBound', scope: 'x' }))).toBe('5 entities · ≥ 7 relationships · loaded · lower bound');
    expect(loadedLine(graph({ quality: 'unknown', scope: 'x' }, exact(2)))).toBe('entities · 2 relationships · loaded · unknown');
  });
});

describe('the remainder line', () => {
  it.each<[string, Count, string]>([
    ['exact', { value: 5, quality: 'exact', scope: 'x' }, '10 shown · 5 not yet retrieved (exact)'],
    ['estimated', { value: 38, quality: 'estimated', scope: 'x' }, '10 shown · ~38 not yet retrieved (estimated)'],
    ['lower bound', { value: 3281, quality: 'lowerBound', scope: 'x' }, '10 shown · ≥ 3,281 not yet retrieved (lower bound)'],
    ['unknown', { quality: 'unknown', scope: 'x' }, '10 shown · more not yet retrieved'],
  ])('reads a %s count', (_name, remainder, expected) => {
    expect(remainderLine(10, remainder)).toBe(expected);
  });

  it('prints no number for a count that says its quality but has no value', () => {
    expect(remainderLine(10, { quality: 'exact', scope: 'x' })).toBe('10 shown · more not yet retrieved');
  });

  it('reads the unknown remainder the shell uses without a number', () => {
    expect(remainderLine(0, UNKNOWN_REMAINDER)).toBe('0 shown · more not yet retrieved');
  });

  it('puts a thousands separator on the shown number too', () => {
    expect(remainderLine(1200, UNKNOWN_REMAINDER)).toBe('1,200 shown · more not yet retrieved');
  });
});

describe('formatNumber', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1,000'],
    [3281, '3,281'],
    [1234567, '1,234,567'],
  ])('writes %d as %s', (value, text) => {
    expect(formatNumber(value)).toBe(text);
  });
});
