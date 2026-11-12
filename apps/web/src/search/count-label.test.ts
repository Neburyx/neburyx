import { describe, expect, it } from 'vitest';
import type { Count } from '@neburyx/contracts';
import { entitiesText, evidenceText, facetCountText, matchesText, relatedText, totalText } from './count-label.js';

const count = (quality: Count['quality'], value?: number): Count => ({ ...(value === undefined ? {} : { value }), quality, scope: 's' });

describe('a count beside a Filters entry', () => {
  it('says an exact count with its word and a lower bound with its words', () => {
    expect(facetCountText(count('exact', 333))).toBe('333 · exact');
    expect(facetCountText(count('exact', 0))).toBe('0 · exact');
    expect(facetCountText(count('lowerBound', 25))).toBe('≥ 25 · lower bound');
  });

  it('draws no number for an estimated count, an unknown one or one with no value, and never says exact for them', () => {
    expect(facetCountText(count('estimated', 40))).toBeUndefined();
    expect(facetCountText(count('unknown'))).toBeUndefined();
    expect(facetCountText(count('exact'))).toBeUndefined();
    expect(facetCountText(count('lowerBound'))).toBeUndefined();
  });
});

describe('the total of the Filters', () => {
  it('says the entities total with its quality, in the singular and the plural', () => {
    expect(entitiesText(count('exact', 334))).toBe('334 entities · exact');
    expect(entitiesText(count('exact', 1))).toBe('1 entity · exact');
    expect(entitiesText(count('lowerBound', 25))).toBe('≥ 25 entities · lower bound');
  });

  it('draws no number for a total with no value or of another quality', () => {
    expect(entitiesText(count('unknown'))).toBeUndefined();
    expect(entitiesText(count('estimated', 9))).toBeUndefined();
    expect(totalText(count('unknown'), count('exact', 3))).toBeUndefined();
  });

  it('gives the supporting relationships part its own quality, and leaves it out for zero, no value or another quality', () => {
    expect(totalText(count('exact', 2), count('exact', 7))).toBe('2 entities · exact · 7 supporting relationships · exact');
    expect(totalText(count('exact', 2), count('exact', 1))).toBe('2 entities · exact · 1 supporting relationship · exact');
    expect(totalText(count('exact', 2), count('lowerBound', 25))).toBe('2 entities · exact · ≥ 25 supporting relationships · lower bound');
    expect(totalText(count('exact', 2), count('exact', 0))).toBe('2 entities · exact');
    expect(totalText(count('exact', 2), count('estimated', 5))).toBe('2 entities · exact');
    expect(totalText(count('exact', 2), undefined)).toBe('2 entities · exact');
  });
});

describe('the summary lines of an answer', () => {
  it('say what they said before the Filters carried a quality word', () => {
    expect(matchesText(count('exact', 1))).toBe('1 exact match');
    expect(matchesText(count('lowerBound', 25))).toBe('≥ 25 exact matches · lower bound');
    expect(relatedText(count('exact', 3))).toBe('3 related records');
    expect(relatedText(count('lowerBound', 25))).toBe('≥ 25 related records · lower bound');
    expect(evidenceText(count('exact', 7))).toBe('7 supporting relationships');
    expect(evidenceText(count('lowerBound', 25))).toBe('≥ 25 supporting relationships · lower bound');
  });
});
