import type { Position } from '../state/presentation-state.js';
import { BOX_HEIGHT, BOX_WIDTH } from './layout-constants.js';

export const keys = (count: number, prefix = 'n'): string[] => Array.from({ length: count }, (_unused, index) => `${prefix}${String(index).padStart(3, '0')}`);

export function overlaps(positions: ReadonlyMap<string, Position>): [string, string][] {
  const entries = [...positions];
  const found: [string, string][] = [];
  for (let a = 0; a < entries.length; a += 1) {
    for (let b = a + 1; b < entries.length; b += 1) {
      const first = entries[a]?.[1] ?? { x: 0, y: 0 };
      const second = entries[b]?.[1] ?? { x: 0, y: 0 };
      if (Math.abs(first.x - second.x) < BOX_WIDTH && Math.abs(first.y - second.y) < BOX_HEIGHT) found.push([entries[a]?.[0] ?? '', entries[b]?.[0] ?? '']);
    }
  }
  return found;
}

export const allFinite = (positions: ReadonlyMap<string, Position>): boolean => [...positions.values()].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
