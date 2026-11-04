import type { AddCapture } from './add.js';
import type { LayoutCapture } from './layout.js';
import type { Readout } from './checks.js';

const view = { zoom: 1, panX: 0, panY: 0 };
export const BEFORE: Readout = { entities: 120, relationships: 180, ...view };
export const AFTER: Readout = { entities: 145, relationships: 205, ...view };

/** Frame times 16.7 ms apart: the last frame before the press, a long one for the add, and the frames after it. */
export const frames = (count = 33, slow = 40): number[] => {
  const times = [0];
  for (let index = 1; index < count; index += 1) times.push((times[index - 1] ?? 0) + (index === 1 ? slow : 16.7));
  return times;
};

export function capture(overrides: Partial<AddCapture> = {}): AddCapture {
  return { times: frames(), drawnAt: 1, before: BEFORE, after: AFTER, marked: 120, movedPinned: 0, movedUnpinned: 0, notice: undefined, ...overrides };
}

export const DISPLACED_IDS: readonly string[] = Array.from({ length: 10 }, (_unused, index) => `displaced-${index}`);

export function layoutCapture(overrides: Partial<LayoutCapture> = {}): LayoutCapture {
  return {
    times: frames(),
    drawnAt: 1,
    before: BEFORE,
    after: BEFORE,
    displaced: { movedPinned: 0, movedUnpinned: 10, ids: DISPLACED_IDS },
    marked: 120,
    movedPinned: 0,
    movedUnpinned: 110,
    movedIds: [...DISPLACED_IDS, ...Array.from({ length: 100 }, (_unused, index) => `other-${index}`)],
    commandMs: 12,
    notice: undefined,
    ...overrides,
  };
}
