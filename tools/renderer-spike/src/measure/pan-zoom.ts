import type { RendererAdapter, ViewState } from '../adapter.js';
import { MeasureError } from './errors.js';
import type { FrameClock } from './clock.js';

export const RUN_DURATION_MS = 10_000;
export const RUNS = 3;

const PAN_X_SHARE = 0.15;
const PAN_Y_SHARE = 0.1;
const ZOOM_SWING = 0.4;
const PAN_X_CYCLES = 2;
const PAN_Y_CYCLES = 3;
const ZOOM_CYCLES = 1.5;
const FULL_TURN = Math.PI * 2;

/** One scripted gesture: progress runs from 0 to 1 and the view pans in both axes while it zooms in and out around the fit view. */
export function viewAt(progress: number): ViewState {
  return {
    zoomFactor: 1 + ZOOM_SWING * Math.sin(FULL_TURN * ZOOM_CYCLES * progress),
    offsetX: PAN_X_SHARE * Math.sin(FULL_TURN * PAN_X_CYCLES * progress),
    offsetY: PAN_Y_SHARE * Math.cos(FULL_TURN * PAN_Y_CYCLES * progress) - PAN_Y_SHARE,
  };
}

/** Applies the gesture on every frame for `durationMs` and returns the frame timestamps, in milliseconds. */
export function measurePanZoom(adapter: RendererAdapter, durationMs: number, clock: FrameClock): Promise<number[]> {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return Promise.reject(new MeasureError('DURATION_INVALID'));
  return new Promise((resolve, reject) => {
    const timestamps: number[] = [];
    const onFrame = (time: number): void => {
      try {
        const first = timestamps[0] ?? time;
        timestamps.push(time);
        const progress = Math.min((time - first) / durationMs, 1);
        adapter.applyView(viewAt(progress));
        if (progress >= 1) resolve(timestamps);
        else clock.nextFrame(onFrame);
      } catch (error) {
        reject(error);
      }
    };
    clock.nextFrame(onFrame);
  });
}
