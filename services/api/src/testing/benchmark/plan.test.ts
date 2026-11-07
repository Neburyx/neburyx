import { describe, expect, it } from 'vitest';
import { positionsOf, READ_SETS, rowsOf, SIZES, WALK_PAGE } from './plan.js';

describe('the plan of the supernode benchmark', () => {
  it('counts the rows each read set holds', () => {
    expect(rowsOf('dated', 100_000)).toBe(100_000);
    expect(rowsOf('undated', 1_000)).toBe(1_000);
    expect(rowsOf('aggregate', 100_000)).toBe(10_000);
    expect(rowsOf('plain', 100_000)).toBe(100_000);
    expect(rowsOf('all', 1_000)).toBe(3_100);
  });

  it('puts every position on a walk-page boundary inside the order', () => {
    for (const size of SIZES) {
      for (const set of READ_SETS) {
        const rows = rowsOf(set, size);
        const positions = positionsOf(rows);
        expect(positions[0]).toEqual({ label: 'first', startRow: 0 });
        for (const position of positions) {
          expect(position.startRow % WALK_PAGE).toBe(0);
          expect(position.startRow).toBeLessThan(rows);
        }
        expect(new Set(positions.map((position) => position.startRow)).size).toBe(positions.length);
      }
    }
  });

  it('drops a deep position that collapses onto an earlier one in a short order', () => {
    expect(positionsOf(100)).toEqual([
      { label: 'first', startRow: 0 },
      { label: '50%', startRow: 50 },
    ]);
    expect(positionsOf(40)).toEqual([{ label: 'first', startRow: 0 }]);
  });
});
