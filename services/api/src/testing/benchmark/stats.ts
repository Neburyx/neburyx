export interface Summary {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** The nearest-rank percentile of values sorted ascending: the smallest value that at least `p` percent of the values do not exceed. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('a percentile needs at least one value');
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

export function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: percentile(sorted, 100) };
}

/** A timed request: how long the call took, and whether the gate answered with an error (a timeout counts as one; it is as long as the call took, never dropped). */
export interface Sample {
  readonly ms: number;
  readonly failed: boolean;
}

export interface SampleSummary extends Summary {
  /** Samples in which the gate answered with an error. */
  readonly failures: number;
}

export function summarizeSamples(samples: readonly Sample[]): SampleSummary {
  return { ...summarize(samples.map((sample) => sample.ms)), failures: samples.filter((sample) => sample.failed).length };
}
