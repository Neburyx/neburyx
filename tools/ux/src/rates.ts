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

/**
 * The longest frame the guard accepts while a layout runs on the 300-element canvas at 4x CPU throttle.
 * The laptop's limit is the renderer decision's: no frame over 100 ms. On the runner a layout run is one redraw of every entity and relationship, and the runner draws any such
 * redraw slower than 100 ms: in the ux job of CI run 42562768987 the first Hierarchical run took 200 ms, and the plain pan and zoom of the same canvas had frames of 150 to 167 ms
 * (the limit of that guard on the runner is 300 ms). The layout itself takes 2.3 ms for the fixture (Force 10.6 ms), so the frame is the drawing and not the computation. On a laptop
 * at 8x throttle the first layout run took 133 ms and at 4x 50 to 60 ms, so the figure scales with the CPU and not with the layout. The runner's limit is therefore the pan and zoom
 * guard's 300 ms: it is above the 200 ms measured and still fails a run that blocks for a third of a second more.
 */
export const LAYOUT_FRAME_LIMIT_MS = { laptop: 100, runner: 300 } as const;

/** The frames, in milliseconds, that are longer than the limit. */
export function framesOver(frames: readonly number[], limitMs: number): number[] {
  return frames.filter((frame) => frame > limitMs);
}

/**
 * The frame rates the guard accepts while an entity is dragged with Physics on, on the 300-element canvas at 4x CPU throttle.
 * The laptop's are the renderer decision's: median 55 fps, 5th percentile 30 fps. The runner's come from the 47 runs of this drag in the ux-benchmark job (`MEASURED_RUNNER_DRAGS`).
 * A frame lasts a whole number of refreshes, so the rates come in steps of 60 / n; the lowest median measured is 5 refreshes (12 fps) and the lowest 5th percentile 7 (8.57 fps), and the
 * runner models overlap, one of them giving 8.57, 10 and 12. The limits are one refresh under the lowest figures: a median of 10 (6 refreshes) and a 5th percentile of 7.5 (8 refreshes).
 * So on the runner the guard catches a drag whose 5th-percentile frame takes 9 refreshes (150 ms) or more, or whose median frame takes 7 (117 ms) or more, and no finer one: the laptop's limits
 * are the fine guard, and CI does not run them. `pnpm --filter @neburyx/ux-tests mutate physics` shows the guard fails with a 150 ms stall at every drag step.
 */
export const PHYSICS_DRAG_THRESHOLD = { laptop: { medianFps: 55, p5Fps: 30 }, runner: { medianFps: 10, p5Fps: 7.5 } } as const satisfies Record<string, Threshold>;

/** The (median, 5th percentile) of each run of the drag in the ux-benchmark job that the CI logs held when the runner's limits were set, by the number of runs. */
export const MEASURED_RUNNER_DRAGS: ReadonlyArray<{ readonly medianFps: number; readonly p5Fps: number; readonly runs: number }> = [
  { medianFps: 20, p5Fps: 15, runs: 18 },
  { medianFps: 15, p5Fps: 12, runs: 17 },
  { medianFps: 15, p5Fps: 10, runs: 8 },
  { medianFps: 20, p5Fps: 12, runs: 2 },
  { medianFps: 12, p5Fps: 10, runs: 1 },
  { medianFps: 12, p5Fps: 60 / 7, runs: 1 },
];
