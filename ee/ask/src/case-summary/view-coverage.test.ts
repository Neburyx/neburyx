import { describe, expect, it } from 'vitest';
import { viewCoverageOf } from './coverage.js';

const reading = (notRetrieved: { quality: string; value?: number }, extra: object = {}) =>
  ({ nodes: [{ ref: { entityType: 'widget' } }, { ref: { entityType: 'widget' } }, { ref: { entityType: 'gadget' } }], edges: [], unresolved: 0, omitted: false, notRetrieved: { ...notRetrieved, scope: 'test' }, uncounted: 0, ...extra }) as never;

describe('the coverage line of the view', () => {
  it('counts the entities by type, by the name the mapping gives, and the relationships, and says what is not yet retrieved', () => {
    const covered = viewCoverageOf(reading({ quality: 'exact', value: 0 }), new Map([['widget', 'Widgets']]));
    expect(covered.text).toBe('3 entities shown (1 gadget, 2 Widgets) · 0 relationships shown · 0 not yet retrieved (exact)');
    expect(covered.inexact).toBeUndefined();
  });

  it('gives the figure of an inexact count with the phrase a sentence must copy, and an unknown one as unknown', () => {
    expect(viewCoverageOf(reading({ quality: 'lowerBound', value: 109 }), undefined).inexact).toEqual({ phrase: '≥ 109', value: '109' });
    expect(viewCoverageOf(reading({ quality: 'estimated', value: 1200 })).inexact).toEqual({ phrase: '~ 1,200', value: '1200' });
    expect(viewCoverageOf(reading({ quality: 'unknown' })).inexact).toBe('unknown');
  });

  it('adds the references that could not be read, and the note that access may hide items', () => {
    const text = viewCoverageOf(reading({ quality: 'exact', value: 0 }, { unresolved: 2 }) as never).text;
    expect(text).toContain('2 references could not be read');
  });
});
