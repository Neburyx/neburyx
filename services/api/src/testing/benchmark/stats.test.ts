import { describe, expect, it } from 'vitest';
import { percentile, summarize, summarizeSamples } from './stats.js';

describe('the statistics of a benchmark', () => {
  it('takes the nearest-rank percentile', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 95)).toBe(19);
  });

  it('summarizes unsorted values without changing them', () => {
    const values = [30, 10, 20];
    expect(summarize(values)).toEqual({ samples: 3, p50: 20, p95: 30, max: 30 });
    expect(values).toEqual([30, 10, 20]);
  });

  it('refuses to summarize nothing', () => {
    expect(() => summarize([])).toThrow('at least one value');
  });
});

describe('the samples of a benchmark', () => {
  it('keeps a failed request as a sample as long as the call took, and counts it', () => {
    const summary = summarizeSamples([
      { ms: 10, failed: false },
      { ms: 5000, failed: true },
      { ms: 20, failed: false },
    ]);
    expect(summary).toEqual({ samples: 3, p50: 20, p95: 5000, max: 5000, failures: 1 });
  });
});
