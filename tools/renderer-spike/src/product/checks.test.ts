import { describe, expect, it } from 'vitest';
import { checkDrag, checkDrawn, checkMotion, checkWheel, checkWheelReturn, parseReadout, type Readout } from './checks.js';

const readout = (overrides: Partial<Readout> = {}): Readout => ({ entities: 120, relationships: 180, zoom: 1, panX: 0, panY: 0, ...overrides });
const inked = { ink: 5000, signature: 'a' };

describe('the read-out of the canvas', () => {
  it('is parsed from the attribute text, and undefined when any value is missing or not a finite number', () => {
    expect(parseReadout({ entities: '120', relationships: '180', zoom: '0.74', panX: '-12.5', panY: '3' })).toEqual({ entities: 120, relationships: 180, zoom: 0.74, panX: -12.5, panY: 3 });
    expect(parseReadout({ entities: '120', relationships: '180', zoom: '0.74', panX: '1' })).toBeUndefined();
    expect(parseReadout({ entities: '120', relationships: 'many', zoom: '1', panX: '0', panY: '0' })).toBeUndefined();
    expect(parseReadout({ entities: '120', relationships: '180', zoom: 'Infinity', panX: '0', panY: '0' })).toBeUndefined();
  });
});

describe('the check that a drawing is there', () => {
  it('fails with CANVAS_MISSING when the canvas carries no read-out', () => {
    expect(() => checkDrawn(undefined, undefined, inked)).toThrow(expect.objectContaining({ code: 'CANVAS_MISSING' }));
  });

  it('fails with RENDERER_FAILED naming the notice when the canvas shows one', () => {
    expect(() => checkDrawn(readout(), 'RENDERER_UNAVAILABLE', inked)).toThrow(expect.objectContaining({ code: 'RENDERER_FAILED', message: expect.stringContaining('RENDERER_UNAVAILABLE') }));
  });

  it('fails with PARTIAL_DRAW when the renderer drew fewer or more than 300 elements, however many were loaded', () => {
    expect(() => checkDrawn(readout({ relationships: 172 }), undefined, inked)).toThrow(expect.objectContaining({ code: 'PARTIAL_DRAW' }));
    expect(() => checkDrawn(readout({ entities: 0, relationships: 0 }), undefined, inked)).toThrow(expect.objectContaining({ code: 'PARTIAL_DRAW' }));
    expect(() => checkDrawn(readout({ entities: 121 }), undefined, inked)).toThrow(expect.objectContaining({ code: 'PARTIAL_DRAW' }));
  });

  it('fails with CANVAS_BLANK when the layers hold no ink, and passes a drawing of 300 elements with ink', () => {
    expect(() => checkDrawn(readout(), undefined, { ink: 0, signature: '0' })).toThrow(expect.objectContaining({ code: 'CANVAS_BLANK' }));
    expect(checkDrawn(readout(), undefined, inked)).toEqual(readout());
  });
});

describe('the check of a wheel step', () => {
  it('passes when a step away from the viewer zooms in and a step toward the viewer zooms out, by a factor between 1.02 and 2', () => {
    expect(() => checkWheel(readout({ zoom: 1 }), readout({ zoom: 1.1 }), -100)).not.toThrow();
    expect(() => checkWheel(readout({ zoom: 1 }), readout({ zoom: 1 / 1.1 }), 100)).not.toThrow();
  });

  it('fails with WHEEL_NO_EFFECT when the zoom did not move, moved the wrong way, or moved by too little or too much', () => {
    for (const after of [1, 0.9, 1.01, 3]) expect(() => checkWheel(readout({ zoom: 1 }), readout({ zoom: after }), -100)).toThrow(expect.objectContaining({ code: 'WHEEL_NO_EFFECT' }));
    expect(() => checkWheel(readout({ zoom: 1 }), readout({ zoom: 1.1 }), 100)).toThrow(expect.objectContaining({ code: 'WHEEL_NO_EFFECT' }));
  });

  it('needs the opposite step to bring the zoom back to within 1 %', () => {
    expect(() => checkWheelReturn(readout({ zoom: 1 }), readout({ zoom: 1.005 }))).not.toThrow();
    expect(() => checkWheelReturn(readout({ zoom: 1 }), readout({ zoom: 1.05 }))).toThrow(expect.objectContaining({ code: 'WHEEL_NO_EFFECT' }));
  });
});

describe('the check of what a run did', () => {
  it('passes a run that zoomed by a factor of at least 1.2 and moved the pan by at least 200 px', () => {
    expect(() => checkMotion({ zoomRatio: 1.2, panTravel: 200 })).not.toThrow();
  });

  it('fails with GESTURE_INEFFECTIVE when the zoom or the pan hardly changed, or the figures are not numbers', () => {
    for (const motion of [{ zoomRatio: 1.05, panTravel: 900 }, { zoomRatio: 1.9, panTravel: 40 }, { zoomRatio: Number.NaN, panTravel: 900 }]) {
      expect(() => checkMotion(motion)).toThrow(expect.objectContaining({ code: 'GESTURE_INEFFECTIVE' }));
    }
  });
});

describe('the check of a drag', () => {
  const before = readout({ panX: 10, panY: 20 });

  it('passes when the renderer pan moved by the drag distance and the picture changed', () => {
    expect(() => checkDrag(before, readout({ panX: 70, panY: 60 }), 60, 40, inked, { ink: 5000, signature: 'b' })).not.toThrow();
    expect(() => checkDrag(before, readout({ panX: 71.5, panY: 58.5 }), 60, 40, inked, { ink: 5000, signature: 'b' })).not.toThrow();
  });

  it('fails with DRAG_NO_EFFECT when the pan did not move by the drag distance', () => {
    expect(() => checkDrag(before, readout({ panX: 10, panY: 20 }), 60, 40, inked, { ink: 5000, signature: 'b' })).toThrow(expect.objectContaining({ code: 'DRAG_NO_EFFECT' }));
    expect(() => checkDrag(before, readout({ panX: 70, panY: 70 }), 60, 40, inked, { ink: 5000, signature: 'b' })).toThrow(expect.objectContaining({ code: 'DRAG_NO_EFFECT' }));
  });

  it('fails with CANVAS_UNCHANGED when the pan moved but the picture is the same one', () => {
    expect(() => checkDrag(before, readout({ panX: 70, panY: 60 }), 60, 40, inked, inked)).toThrow(expect.objectContaining({ code: 'CANVAS_UNCHANGED' }));
  });
});
