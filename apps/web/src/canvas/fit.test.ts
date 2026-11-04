import { describe, expect, it } from 'vitest';
import { fitViewport } from './fit.js';
import { ZOOM_MAX } from './zoom.js';

const SIZE = { width: 800, height: 600 };

describe('the fit viewport', () => {
  it('is undefined while the canvas has no area', () => {
    expect(fitViewport({ x1: 0, y1: 0, x2: 10, y2: 10 }, { width: 0, height: 600 }, 24)).toBeUndefined();
    expect(fitViewport({ x1: 0, y1: 0, x2: 10, y2: 10 }, { width: 800, height: Number.NaN }, 24)).toBeUndefined();
  });

  it('centres the box and uses the larger zoom that leaves the padding on every side', () => {
    const viewport = fitViewport({ x1: 100, y1: 100, x2: 1100, y2: 400 }, SIZE, 50);
    expect(viewport?.zoom).toBeCloseTo(0.7, 5);
    expect(viewport?.x).toBeCloseTo(400 - 0.7 * 600, 5);
    expect(viewport?.y).toBeCloseTo(300 - 0.7 * 250, 5);
  });

  it('is capped at the maximum zoom for a box that is small or has no area', () => {
    expect(fitViewport({ x1: 0, y1: 0, x2: 10, y2: 10 }, SIZE, 24)?.zoom).toBe(ZOOM_MAX);
    expect(fitViewport({ x1: 5, y1: 5, x2: 5, y2: 5 }, SIZE, 24)?.zoom).toBe(ZOOM_MAX);
  });

  it('goes below the minimum zoom for a very spread box and still contains it, however large', () => {
    for (const span of [20000, 1e9]) {
      const viewport = fitViewport({ x1: 0, y1: 0, x2: span, y2: 100 }, SIZE, 48);
      expect(viewport?.zoom).toBeCloseTo((800 - 96) / span, 12);
      const left = (viewport?.x ?? 0) + (viewport?.zoom ?? 0) * 0;
      const right = (viewport?.x ?? 0) + (viewport?.zoom ?? 0) * span;
      expect(left).toBeGreaterThanOrEqual(48 - 1e-6);
      expect(right).toBeLessThanOrEqual(800 - 48 + 1e-6);
    }
  });

  it('drops the margin when the padding takes the whole canvas, and still fits the box', () => {
    const viewport = fitViewport({ x1: 0, y1: 0, x2: 100, y2: 100 }, { width: 80, height: 80 }, 48);
    expect(viewport?.zoom).toBeCloseTo(0.8, 12);
  });
});
