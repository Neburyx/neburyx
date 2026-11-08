import { describe, expect, it } from 'vitest';
import { centreOf, radialLayout } from './radial-layout.js';
import { allFinite, keys, overlaps } from './layout-test-kit.js';
import type { Position } from '../state/presentation-state.js';

const origin = { x: 0, y: 0 };
const run = (ids: string[], links: [string, string][], selected: string[] = [], fixed = new Map<string, Position>()) => radialLayout({ ids, links, fixed, selected, centre: origin });
const at = (placed: Map<string, Position>, id: string): Position => placed.get(id) ?? { x: NaN, y: NaN };
const distance = (placed: Map<string, Position>, id: string, other: Position = origin): number => Math.hypot(at(placed, id).x - other.x, at(placed, id).y - other.y);

describe('the radial layout', () => {
  const ids = ['hub', 'a', 'b', 'c', 'a1', 'b1'];
  const links: [string, string][] = [['hub', 'a'], ['hub', 'b'], ['hub', 'c'], ['a', 'a1'], ['b', 'b1']];

  it('puts the selected entity in the middle, its neighbors on the first ring and theirs on the second', () => {
    const placed = run(ids, links, ['hub']);
    expect(at(placed, 'hub')).toEqual(origin);
    const first = ['a', 'b', 'c'].map((id) => distance(placed, id));
    expect(Math.max(...first) - Math.min(...first)).toBeLessThan(1e-6);
    expect(distance(placed, 'a1')).toBeGreaterThan(first[0] ?? 0);
    expect(distance(placed, 'a1')).toBeCloseTo(distance(placed, 'b1'));
    expect(overlaps(placed)).toEqual([]);
  });

  it('puts the first selected entity in the middle when several are selected, and ignores what is not an entity shown', () => {
    expect(centreOf(ids, links, ['gone', 'b', 'a'])).toBe('b');
    expect(centreOf(ids, links, ['relationship-key'])).toBe('hub');
  });

  it('puts the most connected entity in the middle when nothing is selected, the lowest key winning a tie', () => {
    expect(centreOf(ids, links, [])).toBe('hub');
    expect(centreOf(['q', 'p'], [['q', 'p']], [])).toBe('p');
  });

  it('puts an entity with no path to the middle in a block outside the outer ring', () => {
    const placed = run([...ids, 'far1', 'far2'], links, ['hub']);
    const outer = Math.max(...ids.map((id) => distance(placed, id)));
    for (const id of ['far1', 'far2']) expect(distance(placed, id)).toBeGreaterThan(outer);
    expect(overlaps(placed)).toEqual([]);
  });

  it('widens a ring that holds more boxes than its circumference fits, so that no two boxes overlap', () => {
    const many = keys(80);
    const placed = run(['hub', ...many], many.map((id) => ['hub', id] as [string, string]), ['hub']);
    expect(overlaps(placed)).toEqual([]);
    expect(allFinite(placed)).toBe(true);
  });

  it('keeps a pinned entity where it is, even the middle one, and clears the others off it', () => {
    const pinned = new Map([['hub', { x: 400, y: 300 }]]);
    const placed = run(ids, links, ['hub'], pinned);
    expect(placed.has('hub')).toBe(false);
    for (const id of ['a', 'b', 'c']) expect(distance(placed, id, { x: 400, y: 300 })).toBeGreaterThan(100);
    const other = new Map([['a', { x: 5, y: 5 }]]);
    const around = run(ids, links, ['hub'], other);
    expect(overlaps(new Map([...around, ...other]))).toEqual([]);
  });

  it('gives the same positions for the same input', () => {
    expect(run(ids, links, ['b'])).toEqual(run(ids, links, ['b']));
  });

  it('takes no part for entities it is not given', () => {
    const placed = run(['hub', 'a'], [['hub', 'a'], ['a', 'hidden']], ['hub']);
    expect([...placed.keys()].sort()).toEqual(['a', 'hub']);
  });

  it('places nothing for nothing', () => {
    expect(run([], []).size).toBe(0);
  });
});
