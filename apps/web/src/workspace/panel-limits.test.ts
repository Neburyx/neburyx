import { describe, expect, it } from 'vitest';
import { dockLimits, drawnWidth, floatingLimits, floatingPlacement, isPanelSize, topBelowObstacles, windowShareWidth } from './panel-limits.js';

describe('the dock limits', () => {
  it('take a widest width of the panel in place of 480 and keep it within half of the workspace', () => {
    expect(dockLimits(1440, 720)).toEqual({ min: 240, max: 688 });
    expect(dockLimits(1280, 720)).toEqual({ min: 240, max: 608 });
    expect(dockLimits(1800, 720)).toEqual({ min: 240, max: 720 });
    expect(dockLimits(1440)).toEqual({ min: 240, max: 480 });
  });

  it('are 240 to 480 in a wide window', () => {
    expect(dockLimits(1440)).toEqual({ min: 240, max: 480 });
  });

  it('keep at least half of the workspace for the canvas, with the two gaps: the maximum is half the workspace less 32', () => {
    expect(dockLimits(1000)).toEqual({ min: 240, max: 468 });
    expect(dockLimits(1281)).toEqual({ min: 240, max: 480 });
    expect(dockLimits(1023)).toEqual({ min: 240, max: 479 });
  });

  it('let the maximum win when it is below 240, at 240 and above it', () => {
    expect(dockLimits(540)).toEqual({ min: 238, max: 238 });
    expect(dockLimits(544)).toEqual({ min: 240, max: 240 });
    expect(dockLimits(546)).toEqual({ min: 240, max: 241 });
    expect(dockLimits(0)).toEqual({ min: 0, max: 0 });
  });

  it('are whole numbers of pixels whatever the measured width', () => {
    expect(dockLimits(1001.7)).toEqual({ min: 240, max: 468 });
    expect(dockLimits(543.9)).toEqual({ min: 239, max: 239 });
  });

  it('put no limit on the space before the width was measured', () => {
    expect(dockLimits(undefined)).toEqual({ min: 240, max: 480 });
  });
});

describe('the floating limits', () => {
  it('are 240 to 480 and at most the canvas width less 32, the maximum winning below 240', () => {
    expect(floatingLimits(1000)).toEqual({ min: 240, max: 480 });
    expect(floatingLimits(400)).toEqual({ min: 240, max: 368 });
    expect(floatingLimits(272)).toEqual({ min: 240, max: 240 });
    expect(floatingLimits(250)).toEqual({ min: 218, max: 218 });
    expect(floatingLimits(400.8)).toEqual({ min: 240, max: 368 });
    expect(floatingLimits(400, 72)).toEqual({ min: 240, max: 312 });
    expect(floatingLimits(300, 72)).toEqual({ min: 212, max: 212 });
    expect(floatingLimits(1000, 72)).toEqual({ min: 240, max: 480 });
  });
});

describe('the width a panel is drawn at', () => {
  const limits = { min: 240, max: 480 };

  it('is the stored width, or the initial one when none was stored, held to the limits', () => {
    expect(drawnWidth(undefined, 320, limits)).toBe(320);
    expect(drawnWidth(400, 320, limits)).toBe(400);
    expect(drawnWidth(100, 320, limits)).toBe(240);
    expect(drawnWidth(900, 320, limits)).toBe(480);
    expect(drawnWidth(undefined, 700, limits)).toBe(480);
  });

  it('ignores a stored width that is not a size and uses the initial width', () => {
    for (const stored of [Number.NaN, Infinity, 0, -5]) expect(drawnWidth(stored, 320, limits)).toBe(320);
  });

  it('knows a size is a finite number above zero', () => {
    expect([1, 320, 0.5].every(isPanelSize)).toBe(true);
    expect([0, -1, Number.NaN, Infinity].some(isPanelSize)).toBe(false);
  });
});

describe('where a floating panel starts and how high it may be', () => {
  it('starts at its offset and may be as high as the canvas less the offset and 16 px', () => {
    expect(floatingPlacement(64, 700)).toEqual({ top: 64, maxHeight: 620 });
  });

  it('lets the offset yield so that the 40 px bar fits 16 px above the canvas bottom, exactly at the boundary and below it', () => {
    expect(floatingPlacement(64, 120)).toEqual({ top: 64, maxHeight: 40 });
    expect(floatingPlacement(64, 119)).toEqual({ top: 63, maxHeight: 40 });
    expect(floatingPlacement(64, 100)).toEqual({ top: 44, maxHeight: 40 });
    expect(floatingPlacement(64, 56)).toEqual({ top: 0, maxHeight: 40 });
  });

  it('never goes above the canvas or below zero in a canvas too short for the bar', () => {
    expect(floatingPlacement(64, 40)).toEqual({ top: 0, maxHeight: 24 });
    expect(floatingPlacement(64, 10)).toEqual({ top: 0, maxHeight: 0 });
  });

  it('puts no limit on the height before the canvas was measured', () => {
    expect(floatingPlacement(64, undefined)).toEqual({ top: 64, maxHeight: undefined });
  });
});

describe('the share of the window', () => {
  it('is a share of the window rounded down to a whole pixel, and nothing for a share outside 0 to 1 or a window not measured', () => {
    expect(windowShareWidth(0.6, 1440)).toBe(864);
    expect(windowShareWidth(0.6, 1280)).toBe(768);
    expect(windowShareWidth(0.6, 634)).toBe(380);
    expect(windowShareWidth(0.6, 635)).toBe(381);
    expect(windowShareWidth(undefined, 1440)).toBeUndefined();
    expect(windowShareWidth(0.6, undefined)).toBeUndefined();
    expect(windowShareWidth(0.6, 0)).toBeUndefined();
    expect(windowShareWidth(0, 1440)).toBeUndefined();
    expect(windowShareWidth(1.2, 1440)).toBeUndefined();
    expect(windowShareWidth(Number.NaN, 1440)).toBeUndefined();
  });

  it('gives floating limits of 60% of the window, not of the canvas, held to the space the canvas has left', () => {
    expect(floatingLimits(1384, 16, windowShareWidth(0.6, 1440))).toEqual({ min: 240, max: 864 });
    expect(floatingLimits(1224, 16, windowShareWidth(0.6, 1280))).toEqual({ min: 240, max: 768 });
    expect(floatingLimits(400, 16, windowShareWidth(0.6, 1440))).toEqual({ min: 240, max: 368 });
    expect(floatingLimits(1384, 16, windowShareWidth(undefined, 1440))).toEqual({ min: 240, max: 480 });
  });

  it('lets the minimum yield in a narrow window: 234 px at a 390 px window, and no room above the opening width up to 634 px', () => {
    expect(floatingLimits(334, 16, windowShareWidth(0.6, 390))).toEqual({ min: 234, max: 234 });
    expect(floatingLimits(578, 16, windowShareWidth(0.6, 634)).max).toBe(380);
    expect(floatingLimits(579, 16, windowShareWidth(0.6, 635)).max).toBe(381);
  });
});

describe('the top of a panel below the boxes it would cover', () => {
  const scope = { left: 24, top: 16, right: 420, bottom: 60 };
  const strip = { left: 16, top: 64, right: 56, bottom: 342 };

  it('moves down to a gap below the scope lines when the panel overlaps them horizontally', () => {
    expect(topBelowObstacles(16, { left: 224, right: 544 }, [scope, strip])).toBe(76);
  });

  it('stays where it is when it is clear of every box horizontally, or already starts below them', () => {
    expect(topBelowObstacles(16, { left: 652, right: 972 }, [scope, strip])).toBe(16);
    expect(topBelowObstacles(64, { left: 72, right: 372 }, [{ ...scope, bottom: 60 }])).toBe(64);
    expect(topBelowObstacles(76, { left: 224, right: 544 }, [scope])).toBe(76);
  });

  it('goes below the lowest of the boxes it overlaps, and a box it only touches does not count', () => {
    expect(topBelowObstacles(16, { left: 20, right: 300 }, [scope, strip])).toBe(358);
    expect(topBelowObstacles(16, { left: 420, right: 700 }, [scope])).toBe(16);
  });

  it('follows a scope box that grew taller, as a long scope line wraps', () => {
    expect(topBelowObstacles(16, { left: 224, right: 544 }, [{ ...scope, bottom: 110 }])).toBe(126);
  });
});
