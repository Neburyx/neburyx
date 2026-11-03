import { describe, expect, it } from 'vitest';
import { frameStatistics } from './frame-stats.js';

describe('frameStatistics', () => {
  it('matches hand-computed values: intervals of 10, 10 and 20 ms are 100, 100 and 50 fps', () => {
    expect(frameStatistics([0, 10, 20, 40])).toEqual({ frames: 3, medianFps: 100, p5Fps: 50 });
  });

  it('takes the median as the nearest rank of the sorted rates', () => {
    expect(frameStatistics([0, 20, 40, 60, 70])).toEqual({ frames: 4, medianFps: 50, p5Fps: 50 });
  });

  it('refuses an empty list and a single timestamp', () => {
    expect(() => frameStatistics([])).toThrowError(expect.objectContaining({ code: 'FRAME_TIMESTAMPS_INVALID' }));
    expect(() => frameStatistics([5])).toThrowError(expect.objectContaining({ code: 'FRAME_TIMESTAMPS_INVALID' }));
  });

  it('refuses timestamps that do not increase or are not numbers', () => {
    expect(() => frameStatistics([0, 10, 10])).toThrowError(expect.objectContaining({ code: 'FRAME_TIMESTAMPS_INVALID' }));
    expect(() => frameStatistics([0, 10, 5])).toThrowError(expect.objectContaining({ code: 'FRAME_TIMESTAMPS_INVALID' }));
    expect(() => frameStatistics([0, Number.NaN])).toThrowError(expect.objectContaining({ code: 'FRAME_TIMESTAMPS_INVALID' }));
  });
});
