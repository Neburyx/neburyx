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
 * The laptop's are the renderer decision's: median 55 fps, 5th percentile 30 fps. On the runner the same drag measured a median of 15 fps and a 5th percentile of 12 fps in the ux job
 * of CI run 42566317180 (633 frames): the runner draws every frame of the moving canvas several times slower than a laptop does at the same throttle. The runner's limits sit just
 * under that figure, a median of 12 and a 5th percentile of 10, so that they fail a run that is clearly slower than the measured one and not the run that was measured.
 */
export const PHYSICS_DRAG_THRESHOLD = { laptop: { medianFps: 55, p5Fps: 30 }, runner: { medianFps: 12, p5Fps: 10 } } as const satisfies Record<string, Threshold>;
