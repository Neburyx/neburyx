import { describe, expect, it } from 'vitest';
import { selectionAfterClick } from './selection-gestures.js';

const some = (...keys: string[]): ReadonlySet<string> => new Set(keys);

describe('the pointer mode pan', () => {
  it.each([
    ['a click on an item', { target: 'a', shift: false }],
    ['a Shift-click on an item', { target: 'a', shift: true }],
    ['a click on empty canvas', { target: undefined, shift: false }],
    ['a Shift-click on empty canvas', { target: undefined, shift: true }],
  ])('leaves the selection as it is for %s', (_name, click) => {
    expect(selectionAfterClick('pan', some('a', 'b'), click)).toBeUndefined();
  });
});

describe('the pointer mode select', () => {
  it('makes a clicked item the only selected one, and changes nothing when it already is', () => {
    expect(selectionAfterClick('select', some('b', 'c'), { target: 'a', shift: false })).toEqual(['a']);
    expect(selectionAfterClick('select', some('a', 'b'), { target: 'a', shift: false })).toEqual(['a']);
    expect(selectionAfterClick('select', some('a'), { target: 'a', shift: false })).toBeUndefined();
  });

  it('adds an unselected item and removes a selected one on a Shift-click, and the others stay', () => {
    expect(selectionAfterClick('select', some('b'), { target: 'a', shift: true })).toEqual(['b', 'a']);
    expect(selectionAfterClick('select', some('a', 'b', 'c'), { target: 'b', shift: true })).toEqual(['a', 'c']);
    expect(selectionAfterClick('select', some('a'), { target: 'a', shift: true })).toEqual([]);
  });

  it('clears the selection on a click on empty canvas, changes nothing when it is already empty, and ignores a Shift-click on empty canvas', () => {
    expect(selectionAfterClick('select', some('a', 'b'), { target: undefined, shift: false })).toEqual([]);
    expect(selectionAfterClick('select', some(), { target: undefined, shift: false })).toBeUndefined();
    expect(selectionAfterClick('select', some('a'), { target: undefined, shift: true })).toBeUndefined();
  });
});
