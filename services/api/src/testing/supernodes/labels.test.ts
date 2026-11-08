import { describe, expect, it } from 'vitest';
import { checkCountLabel } from './labels.js';

describe('the label of a count', () => {
  it.each([
    { value: 500, quality: 'exact', scope: 's' },
    { value: 500, quality: 'lowerBound', scope: 's' },
    { value: 1200, quality: 'estimated', scope: 's', observedAt: '2026-01-02' },
    { value: 1200, quality: 'estimated', scope: 's' },
    { quality: 'unknown', scope: 's' },
  ])('accepts %j', (count) => {
    expect(() => checkCountLabel(count, 'a count')).not.toThrow();
  });

  it.each([
    ['a count with no quality', { value: 5, scope: 's' }],
    ['an unknown count that carries a number', { value: 5, quality: 'unknown', scope: 's' }],
    ['a number with no value', { quality: 'exact', scope: 's' }],
    ['an observedAt on an exact count', { value: 5, quality: 'exact', scope: 's', observedAt: '2026-01-02' }],
    ['an invented quality', { value: 5, quality: 'about', scope: 's' }],
  ])('fails %s, naming the count', (_name, count) => {
    expect(() => checkCountLabel(count, 'the preview')).toThrow(/^the preview: a count the contract refuses/);
  });
});
