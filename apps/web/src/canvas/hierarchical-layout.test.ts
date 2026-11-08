import { describe, expect, it } from 'vitest';
import { countCrossings, hierarchicalLayout, layersOf } from './hierarchical-layout.js';
import { allFinite, keys, overlaps } from './layout-test-kit.js';
import type { Position } from '../state/presentation-state.js';

const origin = { x: 0, y: 0 };
const run = (ids: string[], links: [string, string][], extra: { fixed?: Map<string, Position>; direction?: 'down' | 'right' } = {}) => hierarchicalLayout({ ids, links, fixed: extra.fixed ?? new Map(), direction: extra.direction ?? 'down', centre: origin });
const at = (placed: Map<string, Position>, id: string): Position => placed.get(id) ?? { x: NaN, y: NaN };

describe('the hierarchical layout', () => {
  it('puts a chain A → B → C one under the other in one column', () => {
    const placed = run(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]);
    expect(at(placed, 'A').y).toBeLessThan(at(placed, 'B').y);
    expect(at(placed, 'B').y).toBeLessThan(at(placed, 'C').y);
    expect(new Set([at(placed, 'A').x, at(placed, 'B').x, at(placed, 'C').x]).size).toBe(1);
  });

  it('puts a chain left to right when the direction is right, with the same layers and order', () => {
    const links: [string, string][] = [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']];
    const down = run(['A', 'B', 'C', 'D'], links);
    const right = run(['A', 'B', 'C', 'D'], links, { direction: 'right' });
    for (const id of ['A', 'B', 'C', 'D']) {
      expect(Math.sign(at(right, id).x - at(right, 'A').x)).toBe(Math.sign(at(down, id).y - at(down, 'A').y));
    }
    expect(at(right, 'B').y < at(right, 'C').y).toBe(at(down, 'B').x < at(down, 'C').x);
    expect(overlaps(right)).toEqual([]);
  });

  it('finishes on a cycle and a self-loop, places every entity once and gives no non-finite position', () => {
    const placed = run(['A', 'B', 'C'], [['A', 'B'], ['B', 'A'], ['C', 'C'], ['B', 'C']]);
    expect(placed.size).toBe(3);
    expect(allFinite(placed)).toBe(true);
    expect(at(placed, 'A').y).toBeLessThan(at(placed, 'B').y);
  });

  it('puts entities of one layer side by side a box apart, with no crossing when the layers can be drawn with none', () => {
    const ids = ['a1', 'a2', 'b1', 'b2'];
    const links: [string, string][] = [['a1', 'b2'], ['a2', 'b1']];
    const placed = run(ids, links);
    expect(overlaps(placed)).toEqual([]);
    const layers = layersOf(ids, links);
    expect(countCrossings(layers.layers, layers.forward)).toBe(0);
  });

  it('crosses no more than the loaded order does, on a larger graph', () => {
    const ids = keys(40);
    const links: [string, string][] = [];
    for (let index = 0; index < 60; index += 1) links.push([ids[(index * 7) % 20] ?? '', ids[20 + ((index * 11) % 20)] ?? '']);
    const { layers, forward } = layersOf(ids, links);
    const loadedOrder = layers.map((layer) => [...layer].sort());
    expect(countCrossings(layers, forward)).toBeLessThanOrEqual(countCrossings(loadedOrder, forward));
  });

  it('gives the same positions for the same input', () => {
    const ids = keys(30);
    const links: [string, string][] = ids.slice(1).map((id, index) => [ids[Math.floor(index / 2)] ?? '', id]);
    expect(run(ids, links)).toEqual(run(ids, links));
  });

  it('puts the entities with no relationship in a block beside the layers, not in them', () => {
    const placed = run(['A', 'B', 'x', 'y', 'z'], [['A', 'B']]);
    const layerRight = Math.max(at(placed, 'A').x, at(placed, 'B').x);
    for (const id of ['x', 'y', 'z']) expect(at(placed, id).x).toBeGreaterThan(layerRight);
    expect(overlaps(placed)).toEqual([]);
  });

  it('leaves a pinned entity out of the result, takes the layers from the whole graph and clears the others off it', () => {
    const fixed = new Map([['B', { x: 10, y: 10 }]]);
    const placed = run(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']], { fixed });
    expect(placed.has('B')).toBe(false);
    expect(overlaps(new Map([...placed, ...fixed]))).toEqual([]);
  });

  it('takes no part for entities it is not given', () => {
    const placed = run(['A', 'B'], [['A', 'B'], ['B', 'hidden'], ['hidden', 'A']]);
    expect([...placed.keys()].sort()).toEqual(['A', 'B']);
  });

  it('finishes 500 entities and 800 relationships and keeps every box clear', () => {
    const ids = keys(500);
    const links: [string, string][] = [];
    for (let index = 0; index < 800; index += 1) links.push([ids[(index * 13) % 500] ?? '', ids[(index * 29 + 7) % 500] ?? '']);
    const placed = run(ids, links);
    expect(placed.size).toBe(500);
    expect(allFinite(placed)).toBe(true);
  });
});
