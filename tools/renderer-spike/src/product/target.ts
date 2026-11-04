/** The frame-rate target recorded with the renderer decision: steady pan and zoom at 300 elements, measured with the CPU slowed 4x. */
export const TARGET = { cpuThrottle: 4, medianFps: 55, p5Fps: 30 } as const;

export type Verdict = 'met' | 'not-met' | 'not-applicable';

export interface RunRates {
  readonly medianFps: number;
  readonly p5Fps: number;
}

/** The target is defined for the 4x throttled run, so a run with less throttle records its figures and gives no verdict. */
export function evaluateTarget(runs: readonly RunRates[], cpuThrottle: number): Verdict {
  if (cpuThrottle < TARGET.cpuThrottle) return 'not-applicable';
  return runs.every((run) => run.medianFps >= TARGET.medianFps && run.p5Fps >= TARGET.p5Fps) ? 'met' : 'not-met';
}
