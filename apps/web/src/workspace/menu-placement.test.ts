import { describe, expect, it } from 'vitest';
import { ANCHOR_GAP, placeAbove, placeMenu, placeSubmenu, POINTER_OFFSET, SUBMENU_GAP, VIEWPORT_MARGIN } from './menu-placement.js';

const VIEWPORT = { width: 1000, height: 800 };
const MENU = { width: 200, height: 100 };

describe('placing a menu', () => {
  it('opens 8 px right of and below the pointer when it fits', () => {
    expect(placeMenu({ x: 100, y: 200 }, MENU, VIEWPORT)).toEqual({ left: 108, top: 208 });
    expect([POINTER_OFFSET, VIEWPORT_MARGIN]).toEqual([8, 8]);
  });

  it('keeps the offset when the menu ends exactly at the margin, and flips when it would pass it by one pixel', () => {
    expect(placeMenu({ x: 784, y: 100 }, MENU, VIEWPORT).left).toBe(792);
    expect(placeMenu({ x: 785, y: 100 }, MENU, VIEWPORT).left).toBe(785 - 8 - 200);
    expect(placeMenu({ x: 100, y: 684 }, MENU, VIEWPORT).top).toBe(692);
    expect(placeMenu({ x: 100, y: 685 }, MENU, VIEWPORT).top).toBe(685 - 8 - 100);
  });

  it('opens left of the pointer, 8 px from it, near the right edge, and above it near the bottom edge', () => {
    expect(placeMenu({ x: 900, y: 100 }, MENU, VIEWPORT)).toMatchObject({ left: 692, top: 108 });
    expect(placeMenu({ x: 100, y: 750 }, MENU, VIEWPORT)).toMatchObject({ left: 108, top: 642 });
  });

  it('flips on both axes in the bottom right corner and on the vertical axis only in the bottom left corner', () => {
    expect(placeMenu({ x: 990, y: 790 }, MENU, VIEWPORT)).toMatchObject({ left: 782, top: 682 });
    expect(placeMenu({ x: 5, y: 795 }, MENU, VIEWPORT)).toMatchObject({ left: 13, top: 687 });
    expect(placeMenu({ x: 995, y: 5 }, MENU, VIEWPORT)).toMatchObject({ left: 787, top: 13 });
  });

  it('holds the menu 8 px inside the viewport when it fits on neither side', () => {
    const wide = { width: 950, height: 100 };
    expect(placeMenu({ x: 100, y: 100 }, wide, VIEWPORT).left).toBe(8);
    const tall = { width: 200, height: 780 };
    expect(placeMenu({ x: 100, y: 400 }, tall, VIEWPORT).top).toBe(8);
    expect(placeMenu({ x: 100, y: 700 }, tall, VIEWPORT).top).toBe(8);
  });

  it('holds a menu taller or wider than the viewport at the margin, as the size the stylesheet limits it to', () => {
    expect(placeMenu({ x: 100, y: 300 }, { width: 200, height: 2000 }, VIEWPORT).top).toBe(8);
    expect(placeMenu({ x: 300, y: 100 }, { width: 2000, height: 100 }, VIEWPORT).left).toBe(8);
  });

  it('never places the menu outside the margins for any pointer position in a small window', () => {
    const small = { width: 300, height: 200 };
    for (let x = 0; x <= small.width; x += 25) {
      for (let y = 0; y <= small.height; y += 25) {
        const place = placeMenu({ x, y }, { width: 250, height: 150 }, small);
        expect(place.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
        expect(place.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
        expect(place.left + 250).toBeLessThanOrEqual(small.width - VIEWPORT_MARGIN);
        expect(place.top + 150).toBeLessThanOrEqual(small.height - VIEWPORT_MARGIN);
      }
    }
  });
});

describe('placing a submenu', () => {
  const row = { left: 100, top: 200, right: 300, bottom: 230 };
  const submenu = { width: 150, height: 120 };

  it('opens to the right of its row, level with it, when it fits', () => {
    expect(placeSubmenu(row, submenu, VIEWPORT)).toEqual({ left: 300 + SUBMENU_GAP, top: 200 });
  });

  it('opens to the left of its row when it would leave the viewport on the right, and keeps the gap', () => {
    const near = { left: 780, top: 200, right: 980, bottom: 230 };
    expect(placeSubmenu(near, submenu, VIEWPORT).left).toBe(780 - SUBMENU_GAP - 150);
  });

  it('keeps the exact gap when it ends at the margin and flips one pixel beyond', () => {
    expect(placeSubmenu({ ...row, right: 836 }, submenu, VIEWPORT).left).toBe(842);
    expect(placeSubmenu({ ...row, left: 600, right: 837 }, submenu, VIEWPORT).left).toBe(600 - SUBMENU_GAP - 150);
  });

  it('is held 8 px inside when it fits on neither side', () => {
    const wide = { width: 900, height: 100 };
    expect(placeSubmenu({ left: 40, top: 200, right: 240, bottom: 230 }, wide, VIEWPORT).left).toBe(VIEWPORT_MARGIN);
  });

  it('moves up until its bottom is 8 px inside the viewport when its row is low, and stays level with the row otherwise', () => {
    expect(placeSubmenu({ ...row, top: 700, bottom: 730 }, submenu, VIEWPORT).top).toBe(800 - 8 - 120);
    expect(placeSubmenu({ ...row, top: 672, bottom: 702 }, submenu, VIEWPORT).top).toBe(672);
  });

  it('holds a submenu taller or wider than the viewport at the margin', () => {
    expect(placeSubmenu(row, { width: 150, height: 2000 }, VIEWPORT).top).toBe(8);
    expect(placeSubmenu(row, { width: 2000, height: 100 }, VIEWPORT).left).toBe(8);
  });

  it('never places a submenu outside the margins for any row in a small window', () => {
    const small = { width: 300, height: 200 };
    for (let left = 0; left <= 200; left += 40) {
      for (let top = 0; top <= 170; top += 30) {
        const place = placeSubmenu({ left, top, right: left + 100, bottom: top + 30 }, { width: 120, height: 90 }, small);
        expect(place.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
        expect(place.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
        expect(place.left + 120).toBeLessThanOrEqual(small.width - VIEWPORT_MARGIN);
        expect(place.top + 90).toBeLessThanOrEqual(small.height - VIEWPORT_MARGIN);
      }
    }
  });
});

describe('placing a popup above its control', () => {
  const control = { left: 800, top: 740, right: 960, bottom: 776 };

  it('opens 6 px above the control with its right edge level with the control\'s', () => {
    expect(placeAbove(control, MENU, VIEWPORT)).toEqual({ left: 960 - 200, top: 740 - ANCHOR_GAP - 100 });
    expect(ANCHOR_GAP).toBe(6);
  });

  it('is held 8 px inside the viewport at the left edge when the control is near it, and at the right edge when the control is past it', () => {
    expect(placeAbove({ left: 10, top: 740, right: 120, bottom: 776 }, MENU, VIEWPORT).left).toBe(VIEWPORT_MARGIN);
    expect(placeAbove({ left: 900, top: 740, right: 1100, bottom: 776 }, MENU, VIEWPORT).left).toBe(1000 - VIEWPORT_MARGIN - 200);
  });

  it('opens below the control when it does not fit above and does fit below, and is held at the top margin when it fits neither way', () => {
    expect(placeAbove({ left: 800, top: 40, right: 960, bottom: 76 }, MENU, VIEWPORT).top).toBe(76 + ANCHOR_GAP);
    expect(placeAbove({ left: 800, top: 40, right: 960, bottom: 760 }, MENU, VIEWPORT).top).toBe(VIEWPORT_MARGIN);
  });

  it('keeps the exact boundary above: a popup that ends 8 px under the top still opens above', () => {
    expect(placeAbove({ left: 800, top: 8 + ANCHOR_GAP + 100, right: 960, bottom: 200 }, MENU, VIEWPORT).top).toBe(VIEWPORT_MARGIN);
    expect(placeAbove({ left: 800, top: 8 + ANCHOR_GAP + 99, right: 960, bottom: 200 }, MENU, VIEWPORT).top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  });

  it('sizes a popup larger than the viewport less its margins as if it were that size', () => {
    const placed = placeAbove(control, { width: 5000, height: 5000 }, VIEWPORT);
    expect(placed).toEqual({ left: VIEWPORT_MARGIN, top: VIEWPORT_MARGIN });
  });
});
