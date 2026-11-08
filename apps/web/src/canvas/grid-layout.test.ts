import { describe, expect, it } from 'vitest';
import { gridLayout } from './grid-layout.js';
import { allFinite, keys, overlaps } from './layout-test-kit.js';
import { BOX_HEIGHT, BOX_WIDTH } from './layout-constants.js';

const origin = { x: 0, y: 0 };

describe('the grid layout', () => {
  it('places nothing for nothing', () => {
    expect(gridLayout({ free: [], fixed: new Map(), centre: origin }).size).toBe(0);
  });

  it('gives every entity a cell a box and a gap apart, so that no two boxes overlap, and fills the rows in the given order', () => {
    const free = keys(23);
    const placed = gridLayout({ free, fixed: new Map(), centre: origin });
    expect(placed.size).toBe(23);
    expect(overlaps(placed)).toEqual([]);
    expect(allFinite(placed)).toBe(true);
    const rows = free.map((id) => placed.get(id)?.y ?? 0);
    expect([...rows].sort((a, b) => a - b)).toEqual(rows);
    const firstRow = free.filter((id) => placed.get(id)?.y === rows[0]);
    expect(firstRow.map((id) => placed.get(id)?.x ?? 0).every((x, at, all) => at === 0 || x > (all[at - 1] ?? 0))).toBe(true);
  });

  it('is roughly square on the screen', () => {
    const placed = [...gridLayout({ free: keys(100), fixed: new Map(), centre: origin }).values()];
    const width = Math.max(...placed.map((p) => p.x)) - Math.min(...placed.map((p) => p.x)) + BOX_WIDTH;
    const height = Math.max(...placed.map((p) => p.y)) - Math.min(...placed.map((p) => p.y)) + BOX_HEIGHT;
    expect(width / height).toBeGreaterThan(0.6);
    expect(width / height).toBeLessThan(1.7);
  });

  it('centres the grid on the centre it is given', () => {
    const placed = [...gridLayout({ free: keys(9), fixed: new Map(), centre: { x: 500, y: -200 } }).values()];
    expect((Math.max(...placed.map((p) => p.x)) + Math.min(...placed.map((p) => p.x))) / 2).toBeCloseTo(500);
    expect((Math.max(...placed.map((p) => p.y)) + Math.min(...placed.map((p) => p.y))) / 2).toBeCloseTo(-200);
  });

  it('leaves a cell a fixed entity reaches into empty, so that no box overlaps a fixed one', () => {
    const fixed = new Map([['pin', { x: 0, y: 0 }]]);
    const placed = gridLayout({ free: keys(9), fixed, centre: origin });
    expect(placed.size).toBe(9);
    expect(overlaps(new Map([...placed, ...fixed]))).toEqual([]);
  });
});
