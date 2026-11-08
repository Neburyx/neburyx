import { describe, expect, it } from 'vitest';
import { placeSelectionBar, type Box } from './selection-bar-place.js';

const region = { width: 1000, height: 600 };
const bar = { width: 300, height: 40 };
const scope: Box = { left: 16, top: 10, right: 316, bottom: 80 };
const strip: Box = { left: 16, top: 90, right: 56, bottom: 200 };

describe('where the selection bar stands', () => {
  it('stays centred at its usual height when it covers nothing', () => {
    expect(placeSelectionBar(region, bar, 22, scope, [scope, strip])).toEqual({ left: undefined, top: 22, clear: true });
  });

  it('moves right of the scope lines, at its usual height, when centred it would cover them', () => {
    expect(placeSelectionBar({ width: 700, height: 600 }, bar, 22, scope, [scope, strip])).toEqual({ left: 324, top: 22, clear: true });
  });

  it('drops below the scope lines when it does not fit beside them, and clear of the tool strip', () => {
    const placed = placeSelectionBar({ width: 500, height: 600 }, { width: 400, height: 40 }, 22, scope, [scope, strip]);
    expect(placed.top).toBe(88);
    expect(placed.left).toBe(84);
  });

  it('keeps clear of a canvas notice on the right', () => {
    const notice: Box = { left: 700, top: 16, right: 984, bottom: 56 };
    expect(placeSelectionBar(region, { width: 500, height: 40 }, 22, scope, [scope, strip, notice])).toEqual({ left: undefined, top: 88, clear: true });
  });

  it('ignores obstacles with no area, so a page without layout keeps the bar centred', () => {
    const none: Box = { left: 0, top: 0, right: 0, bottom: 0 };
    expect(placeSelectionBar({ width: 0, height: 0 }, { width: 0, height: 0 }, 22, none, [none])).toEqual({ left: undefined, top: 22, clear: true });
  });

  it('caps its width, right of the tool strip and below the scope lines, when no place is clear at its own width', () => {
    const floor: Box = { left: 0, top: 100, right: 592, bottom: 600 };
    expect(placeSelectionBar({ width: 592, height: 600 }, { width: 560, height: 46 }, 22, scope, [scope, strip, floor])).toEqual({ left: 64, top: 88, maxWidth: 512, clear: false });
  });

  it('stands along the bottom edge when the top is taken by the scope lines, the tool strip and a panel', () => {
    const panel: Box = { left: 256, top: 64, right: 576, bottom: 456 };
    expect(placeSelectionBar({ width: 592, height: 572 }, { width: 330, height: 41 }, 22, scope, [scope, strip, panel])).toEqual({ left: undefined, top: 515, clear: true });
  });
});
