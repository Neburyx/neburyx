import { MeasureError } from './errors.js';

export interface FrameStatistics {
  readonly frames: number;
  readonly medianFps: number;
  readonly p5Fps: number;
}

const MS_PER_SECOND = 1000;
const WORST_SHARE = 0.05;

function nearestRank(sorted: readonly number[], share: number): number {
  const index = Math.max(Math.ceil(share * sorted.length) - 1, 0);
  return sorted[index] ?? 0;
}

/** `frames` counts intervals between timestamps; `p5Fps` is the frame rate the slowest 5% of frames fell to (nearest rank). */
export function frameStatistics(timestamps: readonly number[]): FrameStatistics {
  if (timestamps.length < 2) throw new MeasureError('FRAME_TIMESTAMPS_INVALID');
  const rates: number[] = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const interval = (timestamps[index] ?? 0) - (timestamps[index - 1] ?? 0);
    if (!Number.isFinite(interval) || interval <= 0) throw new MeasureError('FRAME_TIMESTAMPS_INVALID');
    rates.push(MS_PER_SECOND / interval);
  }
  const sorted = [...rates].sort((first, second) => first - second);
  return { frames: rates.length, medianFps: nearestRank(sorted, 0.5), p5Fps: nearestRank(sorted, WORST_SHARE) };
}
