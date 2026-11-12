import { describe, expect, it } from 'vitest';
import { COVERAGE_MAX_ENTITIES, COVERAGE_SCOPE, combineCoverage, coverageRequestSchema, coverageResponseSchema, notRetrievedText } from './coverage.js';
import type { Count } from './graph.js';

const entity = (id: string, loadedRelationships = 0) => ({ ref: { sourceId: 'demo', entityType: 'widget', stableId: id }, loadedRelationships, loadedQuality: 'exact' });

describe('the coverage request', () => {
  it('accepts one entity and as many as the limit', () => {
    expect(coverageRequestSchema.safeParse({ sourceId: 'demo', entities: [entity('W-1')] }).success).toBe(true);
    const full = Array.from({ length: COVERAGE_MAX_ENTITIES }, (_unused, index) => entity(`W-${index}`));
    expect(coverageRequestSchema.safeParse({ sourceId: 'demo', entities: full }).success).toBe(true);
  });

  it('refuses an empty list, one entity over the limit, an unknown field, and a count that is negative or not whole', () => {
    const over = Array.from({ length: COVERAGE_MAX_ENTITIES + 1 }, (_unused, index) => entity(`W-${index}`));
    expect(coverageRequestSchema.safeParse({ sourceId: 'demo', entities: [] }).success).toBe(false);
    expect(coverageRequestSchema.safeParse({ sourceId: 'demo', entities: over }).success).toBe(false);
    expect(coverageRequestSchema.safeParse({ sourceId: 'demo', entities: [entity('W-1')], extra: 1 }).success).toBe(false);
    expect(coverageRequestSchema.safeParse({ sourceId: 'demo', entities: [entity('W-1', -1)] }).success).toBe(false);
    expect(coverageRequestSchema.safeParse({ sourceId: 'demo', entities: [entity('W-1', 1.5)] }).success).toBe(false);
  });
});

describe('the coverage response', () => {
  it('has a value exactly when its quality is not unknown', () => {
    expect(coverageResponseSchema.safeParse({ notRetrieved: { value: 3, quality: 'exact', scope: 'not yet retrieved' }, uncounted: 0 }).success).toBe(true);
    expect(coverageResponseSchema.safeParse({ notRetrieved: { quality: 'unknown', scope: 'not yet retrieved' }, uncounted: 2 }).success).toBe(true);
    expect(coverageResponseSchema.safeParse({ notRetrieved: { value: 3, quality: 'unknown', scope: 'not yet retrieved' }, uncounted: 0 }).success).toBe(false);
  });
});

const chunk = (value: number, quality: Exclude<Count['quality'], 'unknown'>): Count => ({ value, quality, scope: COVERAGE_SCOPE });
const unknownChunk: Count = { quality: 'unknown', scope: COVERAGE_SCOPE };

describe('joining the answers for the chunks of one graph', () => {
  const cases: readonly (readonly [string, readonly Count[], Count])[] = [
    ['one chunk is its own answer', [chunk(5, 'exact')], chunk(5, 'exact')],
    ['exact when every chunk is exact and only one has anything left', [chunk(0, 'exact'), chunk(5, 'exact'), chunk(0, 'exact')], chunk(5, 'exact')],
    ['estimated with the sum when two chunks have something left', [chunk(2, 'exact'), chunk(3, 'exact')], chunk(5, 'estimated')],
    ['exact zero when nothing is left anywhere', [chunk(0, 'exact'), chunk(0, 'exact')], chunk(0, 'exact')],
    ['estimated when a chunk is estimated, even with one left', [chunk(0, 'exact'), chunk(5, 'estimated')], chunk(5, 'estimated')],
    ['lowerBound with the largest exact or lowerBound value, not the sum', [chunk(500, 'lowerBound'), chunk(9, 'exact'), chunk(300, 'lowerBound')], chunk(500, 'lowerBound')],
    ['an estimated chunk adds no floor beside a lowerBound chunk', [chunk(900, 'estimated'), chunk(40, 'lowerBound')], chunk(40, 'lowerBound')],
    ['an unknown chunk beside an exact chunk gives its value as a floor', [chunk(184481, 'exact'), unknownChunk], chunk(184481, 'lowerBound')],
    ['an unknown chunk beside lowerBound and exact chunks gives the largest as a floor', [chunk(500, 'lowerBound'), unknownChunk, chunk(9, 'exact')], chunk(500, 'lowerBound')],
    ['every chunk unknown', [unknownChunk, unknownChunk], { quality: 'unknown', scope: COVERAGE_SCOPE }],
    ['an unknown chunk beside only an estimated chunk stays unknown', [chunk(40, 'estimated'), unknownChunk], { quality: 'unknown', scope: COVERAGE_SCOPE }],
    ['an unknown chunk beside a chunk with nothing left stays unknown', [chunk(0, 'exact'), unknownChunk], { quality: 'unknown', scope: COVERAGE_SCOPE }],
    ['unknown when the sum passes the largest safe integer', [chunk(Number.MAX_SAFE_INTEGER, 'exact'), chunk(1, 'exact')], { quality: 'unknown', scope: COVERAGE_SCOPE }],
    ['unknown for no chunks', [], { quality: 'unknown', scope: COVERAGE_SCOPE }],
  ];
  it.each(cases)('%s', (_name, chunks, expected) => {
    expect(combineCoverage(chunks)).toEqual(expected);
  });
});

describe('combining coverage chunks with an estimate', () => {
  const chunk = (value: number, quality: 'exact' | 'estimated' | 'lowerBound', observedAt?: string): Count => ({ value, quality, scope: COVERAGE_SCOPE, ...(observedAt === undefined ? {} : { observedAt }) });

  it('is at best estimated when one chunk is estimated, and never exact', () => {
    expect(combineCoverage([chunk(10, 'exact'), chunk(5, 'estimated')])).toEqual({ value: 15, quality: 'estimated', scope: COVERAGE_SCOPE });
    expect(combineCoverage([chunk(0, 'exact'), chunk(5, 'estimated')])).toEqual({ value: 5, quality: 'estimated', scope: COVERAGE_SCOPE });
  });

  it('takes no floor from an estimated chunk beside a lowerBound chunk', () => {
    expect(combineCoverage([chunk(10_000, 'estimated'), chunk(500, 'lowerBound')])).toEqual({ value: 500, quality: 'lowerBound', scope: COVERAGE_SCOPE });
  });

  it('carries no date of a chunk', () => {
    expect(combineCoverage([chunk(5, 'estimated', '2026-01-02'), chunk(1, 'exact')])).not.toHaveProperty('observedAt');
    expect(combineCoverage([chunk(5, 'estimated', '2026-01-02')])).not.toHaveProperty('observedAt');
  });
});

describe('the coverage response, what could not be counted', () => {
  const notRetrieved = { value: 3, quality: 'exact', scope: 'not yet retrieved' };

  it('carries a whole number that is not negative, and refuses an answer without it, a negative one and a fraction', () => {
    expect(coverageResponseSchema.safeParse({ notRetrieved, uncounted: 25 }).success).toBe(true);
    expect(coverageResponseSchema.safeParse({ notRetrieved }).success).toBe(false);
    expect(coverageResponseSchema.safeParse({ notRetrieved, uncounted: -1 }).success).toBe(false);
    expect(coverageResponseSchema.safeParse({ notRetrieved, uncounted: 1.5 }).success).toBe(false);
  });
});

describe('the not-yet-retrieved text of a coverage line', () => {
  const count = (quality: Count['quality'], value?: number): Count => ({ ...(value === undefined ? {} : { value }), quality, scope: COVERAGE_SCOPE });

  it('says a lower bound with the number of entities not yet counted, in the singular and the plural', () => {
    expect(notRetrievedText(count('lowerBound', 109), 25)).toBe('≥ 109 not yet retrieved (lower bound · 25 entities not yet counted)');
    expect(notRetrievedText(count('lowerBound', 1_234), 1)).toBe('≥ 1,234 not yet retrieved (lower bound · 1 entity not yet counted)');
  });

  it('says a lower bound with no entity not yet counted as before, with no reason', () => {
    expect(notRetrievedText(count('lowerBound', 43), 0)).toBe('≥ 43 not yet retrieved (lower bound)');
  });

  it('says an unknown count with no number, and with the reason when entities are not yet counted', () => {
    expect(notRetrievedText(count('unknown'), 25)).toBe('more not yet retrieved (25 entities not yet counted)');
    expect(notRetrievedText(count('unknown'), 0)).toBe('more not yet retrieved');
  });

  it('says an exact and an estimated count with their own word', () => {
    expect(notRetrievedText(count('exact', 109), 0)).toBe('109 not yet retrieved (exact)');
    expect(notRetrievedText(count('estimated', 38), 0)).toBe('~38 not yet retrieved (estimated)');
  });
});
