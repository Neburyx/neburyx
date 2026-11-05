import { describe, expect, it } from 'vitest';
import { shortfalls } from './rates.ts';

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
