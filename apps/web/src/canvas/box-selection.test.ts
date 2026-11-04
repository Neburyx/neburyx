import { describe, expect, it } from 'vitest';
import { boxBetween, entitiesInBox, selectionAfterBox } from './box-selection.js';

describe('a box between two points', () => {
  it('is the same whichever corner the drag started from', () => {
    const expected = { x1: 10, y1: 20, x2: 50, y2: 80 };
    expect(boxBetween({ x: 10, y: 20 }, { x: 50, y: 80 })).toEqual(expected);
    expect(boxBetween({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual(expected);
    expect(boxBetween({ x: 50, y: 20 }, { x: 10, y: 80 })).toEqual(expected);
  });
});

describe('the entities in a box', () => {
  const centres = new Map([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 50 }], ['c', { x: 101, y: 50 }], ['d', { x: 100, y: -1 }]]);

  it('are those whose centre lies in it, the edge included', () => {
    expect(entitiesInBox(centres, { x1: 0, y1: 0, x2: 100, y2: 50 })).toEqual(['a', 'b']);
  });

  it('are none for a box that holds no centre', () => {
    expect(entitiesInBox(centres, { x1: 200, y1: 200, x2: 300, y2: 300 })).toEqual([]);
  });
});

describe('the selection after a box', () => {
  const selection = new Set(['x', 'y']);

  it('is the entities inside when Shift was not held, and nothing changes when they are the selection already', () => {
    expect(selectionAfterBox(selection, { ids: ['a', 'b'], shift: false })).toEqual(['a', 'b']);
    expect(selectionAfterBox(selection, { ids: ['y', 'x'], shift: false })).toBeUndefined();
  });

  it('is empty for a box with no entity when Shift was not held', () => {
    expect(selectionAfterBox(selection, { ids: [], shift: false })).toEqual([]);
    expect(selectionAfterBox(new Set(), { ids: [], shift: false })).toBeUndefined();
  });

  it('adds the entities inside when Shift was held, changes nothing for a box with none or only selected ones', () => {
    expect(selectionAfterBox(selection, { ids: ['a', 'x'], shift: true })).toEqual(['x', 'y', 'a']);
    expect(selectionAfterBox(selection, { ids: [], shift: true })).toBeUndefined();
    expect(selectionAfterBox(selection, { ids: ['x'], shift: true })).toBeUndefined();
  });
});
