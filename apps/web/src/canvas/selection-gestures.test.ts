import { describe, expect, it } from 'vitest';
import { modifierOf, selectionAfterClick } from './selection-gestures.js';

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

describe('the toggle modifier (⌘ on a Mac, Ctrl elsewhere)', () => {
  it('leaves the selection as it is in the mode pan, as Shift does', () => {
    expect(selectionAfterClick('pan', some('a', 'b'), { target: 'a', shift: false, toggle: true })).toBeUndefined();
    expect(selectionAfterClick('pan', some('a', 'b'), { target: undefined, shift: false, toggle: true })).toBeUndefined();
  });

  it.each(['select', 'box'] as const)('adds an unselected item and removes a selected one in the mode %s, and the others stay', (tool) => {
    expect(selectionAfterClick(tool, some('b'), { target: 'a', shift: false, toggle: true })).toEqual(['b', 'a']);
    expect(selectionAfterClick(tool, some('a', 'b', 'c'), { target: 'b', shift: false, toggle: true })).toEqual(['a', 'c']);
    expect(selectionAfterClick(tool, some('a'), { target: 'a', shift: false, toggle: true })).toEqual([]);
  });

  it('ignores a click on empty canvas, as a Shift-click is', () => {
    expect(selectionAfterClick('select', some('a'), { target: undefined, shift: false, toggle: true })).toBeUndefined();
    expect(selectionAfterClick('select', some(), { target: undefined, shift: false, toggle: true })).toBeUndefined();
  });

  it('builds a selection of a relationship and an entity one click at a time', () => {
    const first = selectionAfterClick('select', some(), { target: 'ab', shift: false, toggle: true });
    expect(first).toEqual(['ab']);
    expect(selectionAfterClick('select', new Set(first), { target: 'a', shift: false, toggle: true })).toEqual(['ab', 'a']);
  });

  it('is the same with an unset toggle as the matrix has always been', () => {
    expect(selectionAfterClick('select', some('b'), { target: 'a', shift: false, toggle: false })).toEqual(['a']);
  });
});

describe('what the modifiers held on a click mean', () => {
  const held = (modifiers: string): { metaKey: boolean; ctrlKey: boolean } => ({ metaKey: modifiers.includes('meta'), ctrlKey: modifiers.includes('ctrl') });

  it.each([
    ['mac', '', 'none'],
    ['mac', 'meta', 'toggle'],
    ['mac', 'ctrl', 'menu'],
    ['mac', 'meta ctrl', 'menu'],
    ['other', '', 'none'],
    ['other', 'ctrl', 'toggle'],
    ['other', 'meta', 'none'],
    ['other', 'meta ctrl', 'none'],
  ] as const)('on %s with %j held is %s', (platform, modifiers, meaning) => {
    expect(modifierOf(held(modifiers), platform)).toBe(meaning);
  });
});
