import { describe, expect, it } from 'vitest';
import { createBoxGesture, type BoxOverlay } from './box-gesture.js';
import type { BoxSelection } from './box-selection.js';
import type { Box } from './fit.js';

function setup() {
  const shown: Box[] = [];
  const state = { hidden: 0 };
  const selected: BoxSelection[] = [];
  const overlay: BoxOverlay = { show: (box) => void shown.push(box), hide: () => void (state.hidden += 1) };
  const centres = new Map([['a', { x: 10, y: 10 }], ['b', { x: 200, y: 200 }]]);
  const gesture = createBoxGesture({ overlay, centres: () => centres, select: (box) => void selected.push(box) });
  return { gesture, shown, state, selected };
}

describe('a box gesture', () => {
  it('shows the box as the pointer moves and, on release, selects the entities in it with the Shift state it started with', () => {
    const { gesture, shown, state, selected } = setup();
    gesture.start({ x: 0, y: 0 }, true);
    expect(gesture.active).toBe(true);
    gesture.move({ x: 50, y: 40 });
    expect(shown).toEqual([{ x1: 0, y1: 0, x2: 50, y2: 40 }]);
    gesture.end({ x: 60, y: 60 });
    expect(selected).toEqual([{ ids: ['a'], shift: true }]);
    expect(state.hidden).toBe(1);
    expect(gesture.active).toBe(false);
  });

  it('selects an empty box as no entity, so the caller can clear the selection', () => {
    const { gesture, selected } = setup();
    gesture.start({ x: 300, y: 300 }, false);
    gesture.end({ x: 400, y: 400 });
    expect(selected).toEqual([{ ids: [], shift: false }]);
  });

  it('treats a press and release in one place as a click: nothing is selected and the box is gone', () => {
    const { gesture, state, selected } = setup();
    gesture.start({ x: 5, y: 5 }, false);
    gesture.end({ x: 5, y: 5 });
    expect(selected).toEqual([]);
    expect(state.hidden).toBe(1);
  });

  it('drops the box with no effect when it is cancelled, and a later release selects nothing', () => {
    const { gesture, state, selected } = setup();
    gesture.start({ x: 0, y: 0 }, false);
    gesture.move({ x: 100, y: 100 });
    gesture.cancel();
    gesture.end({ x: 100, y: 100 });
    expect(selected).toEqual([]);
    expect(state.hidden).toBe(1);
    expect(gesture.active).toBe(false);
  });

  it('ignores a move and a release when no box was started', () => {
    const { gesture, shown, state, selected } = setup();
    gesture.move({ x: 10, y: 10 });
    gesture.end({ x: 10, y: 10 });
    expect(shown).toEqual([]);
    expect(selected).toEqual([]);
    expect(state.hidden).toBe(0);
  });
});
