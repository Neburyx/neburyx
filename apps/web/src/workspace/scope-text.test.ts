import type { Count } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { formatNumber, loadedLine, notDrawnLine, remainderLine, savedLayoutLine, savedLayoutShownLine, UNKNOWN_REMAINDER } from './scope-text.js';

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
    expect(remainderLine(10, { count: remainder, uncounted: 0 })).toBe(expected);
  });

  it('prints no number for a count that says its quality but has no value', () => {
    expect(remainderLine(10, { count: { quality: 'exact', scope: 'x' }, uncounted: 0 })).toBe('10 shown · more not yet retrieved');
  });

  it('says why a lower bound is one: the entities not yet counted, in the singular and the plural', () => {
    expect(remainderLine(26, { count: { value: 109, quality: 'lowerBound', scope: 'x' }, uncounted: 25 })).toBe('26 shown · ≥ 109 not yet retrieved (lower bound · 25 entities not yet counted)');
    expect(remainderLine(2, { count: { value: 3, quality: 'lowerBound', scope: 'x' }, uncounted: 1 })).toBe('2 shown · ≥ 3 not yet retrieved (lower bound · 1 entity not yet counted)');
  });

  it('says an unknown count with no number and with the entities not yet counted', () => {
    expect(remainderLine(26, { count: { quality: 'unknown', scope: 'x' }, uncounted: 25 })).toBe('26 shown · more not yet retrieved (25 entities not yet counted)');
  });

  it('gives an exact and an estimated count no reason', () => {
    expect(remainderLine(26, { count: { value: 109, quality: 'exact', scope: 'x' }, uncounted: 0 })).toBe('26 shown · 109 not yet retrieved (exact)');
    expect(remainderLine(26, { count: { value: 109, quality: 'estimated', scope: 'x' }, uncounted: 0 })).toBe('26 shown · ~109 not yet retrieved (estimated)');
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

describe('the not drawn line', () => {
  it('is absent for none', () => {
    expect(notDrawnLine(0)).toBeUndefined();
  });

  it('uses the singular for one and the plural, with a thousands separator, for many', () => {
    expect(notDrawnLine(1)).toBe('1 relationship not drawn (entity not loaded)');
    expect(notDrawnLine(1200)).toBe('1,200 relationships not drawn (entity not loaded)');
  });
});

describe('the scope lines of a saved layout whose source was not read', () => {
  it('say "saved layout, not read" instead of "loaded", keep the count quality out of a claim about a read, and name no remainder', () => {
    const graph = { nodes: [], edges: [], entities: { value: 19, quality: 'exact', scope: 'loaded in this view' }, relationships: { value: 1, quality: 'exact', scope: 'loaded in this view' } } as never;
    expect(savedLayoutLine(graph)).toBe('19 entities · 1 relationship · saved layout, not read');
    expect(savedLayoutShownLine(19)).toBe('19 shown');
    expect(savedLayoutShownLine(1200)).toBe('1,200 shown');
  });
});
