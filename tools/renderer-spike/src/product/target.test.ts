import { describe, expect, it } from 'vitest';
import { evaluateTarget, TARGET } from './target.js';

const good = { medianFps: 59.9, p5Fps: 53.8 };

describe('the frame-rate target', () => {
  it('is the one recorded with the renderer decision: 55 fps median and 30 fps at the 5th percentile with the CPU slowed 4x', () => {
    expect(TARGET).toEqual({ cpuThrottle: 4, medianFps: 55, p5Fps: 30 });
  });

  it('is met when every run reaches both figures at the throttle it is defined for', () => {
    expect(evaluateTarget([good, good, { medianFps: 55, p5Fps: 30 }], 4)).toBe('met');
    expect(evaluateTarget([good], 8)).toBe('met');
  });

  it('is not met when any run falls short of either figure', () => {
    expect(evaluateTarget([good, { medianFps: 54.9, p5Fps: 40 }], 4)).toBe('not-met');
    expect(evaluateTarget([good, { medianFps: 60, p5Fps: 29.9 }], 4)).toBe('not-met');
  });

  it('gives no verdict for a run with less throttle than the target is defined for', () => {
    expect(evaluateTarget([{ medianFps: 1, p5Fps: 1 }], 1)).toBe('not-applicable');
    expect(evaluateTarget([good], 3)).toBe('not-applicable');
  });
});
