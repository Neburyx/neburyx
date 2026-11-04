import { describe, expect, it } from 'vitest';
import type { Position } from '../state/presentation-state.js';
import { MARK_EVENT, movedSince, writeReadout } from './canvas-readout.js';

const at = (...entries: ReadonlyArray<readonly [string, number, number]>): Map<string, Position> => new Map(entries.map(([id, x, y]) => [id, { x, y }] as const));
const VIEW = { zoom: 1, x: 0, y: 0 };
const draw = (element: HTMLElement, positions: ReadonlyMap<string, Position>, pinned: readonly string[] = []): void => writeReadout(element, { entities: positions.size, relationships: 0, viewport: VIEW, drawn: { positions, pinned: new Set(pinned) } });
const mark = (element: HTMLElement): void => void element.dispatchEvent(new Event(MARK_EVENT));

describe('the entities drawn elsewhere than at a mark', () => {
  it('are counted, the pinned and the unpinned apart, and an entity that is no longer drawn counts as moved', () => {
    const mark = at(['a', 0, 0], ['b', 1, 1], ['c', 2, 2], ['d', 3, 3]);
    expect(movedSince(mark, at(['a', 0, 0], ['b', 9, 1], ['c', 2, 2]), new Set(['b', 'd']))).toEqual({ pinned: 2, unpinned: 0, ids: ['b', 'd'] });
    expect(movedSince(mark, at(['a', 0, 0], ['b', 1, 1], ['c', 2, 3], ['d', 3, 3]), new Set(['b']))).toEqual({ pinned: 0, unpinned: 1, ids: ['c'] });
  });

  it('are none when every marked entity is where it was, and entities that arrived after the mark are not counted', () => {
    expect(movedSince(at(['a', 0, 0]), at(['a', 0, 0], ['z', 5, 5]), new Set())).toEqual({ pinned: 0, unpinned: 0, ids: [] });
  });
});

describe('the read-out on the canvas element', () => {
  it('carries no mark and no moved counts until a mark is made', () => {
    const element = document.createElement('div');
    draw(element, at(['a', 0, 0]));
    expect(element.dataset['drawnEntities']).toBe('1');
    expect(element.dataset['markedEntities']).toBeUndefined();
    expect(element.dataset['movedUnpinned']).toBeUndefined();
  });

  it('counts the entities moved since the mark across later redraws, even when a redraw changes nothing', () => {
    const element = document.createElement('div');
    draw(element, at(['a', 0, 0], ['b', 1, 1]), ['b']);
    mark(element);
    expect(element.dataset['markedEntities']).toBe('2');
    expect(element.dataset['movedUnpinned']).toBe('0');
    draw(element, at(['a', 7, 0], ['b', 1, 1]), ['b']);
    expect(element.dataset['movedUnpinned']).toBe('1');
    draw(element, at(['a', 7, 0], ['b', 1, 1]), ['b']);
    expect(element.dataset['movedUnpinned']).toBe('1');
    expect(element.dataset['movedPinned']).toBe('0');
    expect(JSON.parse(element.dataset['movedIds'] ?? 'null')).toEqual(['a']);
  });

  it('counts a moved pinned entity apart from the unpinned ones', () => {
    const element = document.createElement('div');
    draw(element, at(['a', 0, 0], ['b', 1, 1]), ['b']);
    mark(element);
    draw(element, at(['a', 0, 0], ['b', 4, 4]), ['b']);
    expect(element.dataset['movedPinned']).toBe('1');
    expect(element.dataset['movedUnpinned']).toBe('0');
  });

  it('measures from the latest mark, and a viewport report without positions changes no count', () => {
    const element = document.createElement('div');
    draw(element, at(['a', 0, 0]));
    mark(element);
    draw(element, at(['a', 3, 3]));
    expect(element.dataset['movedUnpinned']).toBe('1');
    writeReadout(element, { entities: 1, relationships: 0, viewport: { zoom: 2, x: 5, y: 5 } });
    expect(element.dataset['movedUnpinned']).toBe('1');
    expect(element.dataset['zoom']).toBe('2');
    mark(element);
    expect(element.dataset['movedUnpinned']).toBe('0');
  });
});
