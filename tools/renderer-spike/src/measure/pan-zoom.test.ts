import { describe, expect, it } from 'vitest';
import { AdapterError, FIT_VIEW, type RendererAdapter, type ViewState } from '../adapter.js';
import { stubAdapter } from '../testing/stub-adapter.js';
import { registerAdapter, createAdapter } from '../adapters/registry.js';
import { frameStatistics } from './frame-stats.js';
import type { FrameClock } from './clock.js';
import { measurePanZoom, viewAt } from './pan-zoom.js';

function fakeClock(intervalMs: number): FrameClock {
  let time = 1000;
  return {
    nextFrame(callback) {
      time += intervalMs;
      callback(time);
    },
  };
}

describe('viewAt', () => {
  it('stays within a zoom of half to one and a half and a pan within a fifth of the viewport', () => {
    for (let step = 0; step <= 100; step += 1) {
      const view = viewAt(step / 100);
      expect(view.zoomFactor).toBeGreaterThanOrEqual(0.5);
      expect(view.zoomFactor).toBeLessThanOrEqual(1.5);
      expect(Math.abs(view.offsetX)).toBeLessThanOrEqual(0.2);
      expect(Math.abs(view.offsetY)).toBeLessThanOrEqual(0.2);
    }
  });

  it('starts at the fit view', () => {
    expect(viewAt(0)).toEqual(FIT_VIEW);
  });
});

describe('measurePanZoom', () => {
  it('applies a view on every frame and returns the timestamps of a run of the given length', async () => {
    const views: ViewState[] = [];
    const timestamps = await measurePanZoom(stubAdapter({ views }), 100, fakeClock(10));
    expect(timestamps).toHaveLength(11);
    expect(views).toHaveLength(11);
    expect(frameStatistics(timestamps)).toEqual({ frames: 10, medianFps: 100, p5Fps: 100 });
  });

  it('runs with an adapter registered by name and no change to the measurement', async () => {
    const views: ViewState[] = [];
    registerAdapter('stub-registered', async () => stubAdapter({ views }));
    const adapter = await createAdapter('stub-registered', undefined);
    const timestamps = await measurePanZoom(adapter, 50, fakeClock(10));
    expect(frameStatistics(timestamps).frames).toBe(5);
  });

  it('refuses a name that is already registered', () => {
    registerAdapter('stub-twice', async () => stubAdapter());
    expect(() => registerAdapter('stub-twice', async () => stubAdapter())).toThrowError(AdapterError);
    expect(() => registerAdapter('cytoscape', async () => stubAdapter())).toThrowError(expect.objectContaining({ code: 'ADAPTER_EXISTS' }));
  });

  it('refuses a duration that is zero, negative or not a finite number, before asking for a frame', async () => {
    let asked = 0;
    const clock: FrameClock = { nextFrame: () => { asked += 1; } };
    for (const duration of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) await expect(measurePanZoom(stubAdapter(), duration, clock)).rejects.toMatchObject({ code: 'DURATION_INVALID' });
    expect(asked).toBe(0);
  });

  it('rejects when the adapter throws while a view is applied', async () => {
    const adapter: RendererAdapter = { ...stubAdapter(), applyView: () => { throw new AdapterError('ADAPTER_NOT_MOUNTED'); } };
    await expect(measurePanZoom(adapter, 100, fakeClock(10))).rejects.toMatchObject({ code: 'ADAPTER_NOT_MOUNTED' });
  });
});
