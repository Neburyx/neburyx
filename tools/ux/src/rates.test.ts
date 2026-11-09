import { describe, expect, it } from 'vitest';
import { framesOver, LAYOUT_FRAME_LIMIT_MS, shortfalls } from './rates.ts';

const FLOOR = { medianFps: 55, p5Fps: 30 };

describe('the benchmark threshold', () => {
  it('says nothing when every run reaches both rates, also when a run is exactly at them', () => {
    expect(shortfalls([{ medianFps: 60, p5Fps: 54 }, { medianFps: 55, p5Fps: 30 }], FLOOR)).toEqual([]);
  });

  it('names each run and each rate that falls below, and fails a run that measured nothing', () => {
    expect(shortfalls([{ medianFps: 60, p5Fps: 54 }, { medianFps: 40, p5Fps: 12 }], FLOOR)).toEqual(['run 2: the median is 40.0 fps, below 55', 'run 2: the 5th percentile is 12.0 fps, below 30']);
    expect(shortfalls([], FLOOR)).toEqual(['no run was measured']);
  });
});

describe('the longest frame accepted while a layout runs', () => {
  it('is 100 ms on a laptop and 300 ms on the runner, and the runner\'s is above the 200 ms measured there', () => {
    expect(LAYOUT_FRAME_LIMIT_MS).toEqual({ laptop: 100, runner: 300 });
    expect(framesOver([200], LAYOUT_FRAME_LIMIT_MS.runner)).toEqual([]);
  });

  it('still fails a frame over the limit of its profile, and none under it', () => {
    expect(framesOver([16.7, 33.4, 101], LAYOUT_FRAME_LIMIT_MS.laptop)).toEqual([101]);
    expect(framesOver([16.7, 250, 301], LAYOUT_FRAME_LIMIT_MS.runner)).toEqual([301]);
    expect(framesOver([16.7, 100], LAYOUT_FRAME_LIMIT_MS.laptop)).toEqual([]);
    expect(framesOver([], LAYOUT_FRAME_LIMIT_MS.runner)).toEqual([]);
  });
});
