export interface Threshold {
  readonly medianFps: number;
  readonly p5Fps: number;
}

export interface MeasuredRun {
  readonly medianFps: number;
  readonly p5Fps: number;
}

/** What a run of the benchmark must reach: the lowest median and the lowest 5th percentile of the frame rate, for every run. */
export function shortfalls(runs: readonly MeasuredRun[], threshold: Threshold): string[] {
  if (runs.length === 0) return ['no run was measured'];
  return runs.flatMap((run, index) => [
    ...(run.medianFps >= threshold.medianFps ? [] : [`run ${index + 1}: the median is ${run.medianFps.toFixed(1)} fps, below ${threshold.medianFps}`]),
    ...(run.p5Fps >= threshold.p5Fps ? [] : [`run ${index + 1}: the 5th percentile is ${run.p5Fps.toFixed(1)} fps, below ${threshold.p5Fps}`]),
  ]);
}
