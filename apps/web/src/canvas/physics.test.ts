import { describe, expect, it } from 'vitest';
import { createPhysics } from './physics.js';
import { allFinite, keys } from './layout-test-kit.js';
import { IDEAL_LENGTH } from './layout-constants.js';

const line = (count: number) => {
  const ids = keys(count);
  return { ids, links: ids.slice(1).map((id, index) => [ids[index] ?? '', id] as [string, string]), positions: new Map(ids.map((id, index) => [id, { x: index * 40, y: (index % 2) * 5 }] as const)) };
};
const settle = (model: ReturnType<typeof createPhysics>, limit = 3000): number => {
  let frames = 0;
  while (!model.settled && frames < limit) {
    model.step();
    frames += 1;
  }
  return frames;
};

describe('the live force model', () => {
  it('settles, with every position finite, and pulls linked entities toward the ideal length', () => {
    const { ids, links, positions } = line(6);
    const model = createPhysics({ ids, links, positions, pinned: new Set() });
    expect(settle(model)).toBeLessThan(3000);
    expect(allFinite(model.positions())).toBe(true);
    const a = model.position('n000') ?? { x: 0, y: 0 };
    const b = model.position('n001') ?? { x: 0, y: 0 };
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(IDEAL_LENGTH * 0.5);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(IDEAL_LENGTH * 1.5);
  });

  it('never moves a pinned entity, and never a held one', () => {
    const { ids, links, positions } = line(5);
    const model = createPhysics({ ids, links, positions, pinned: new Set(['n002']) });
    model.hold('n004', { x: 900, y: 900 });
    const pinnedAt = model.position('n002');
    for (let frame = 0; frame < 200; frame += 1) {
      model.step();
      expect(model.position('n002')).toEqual(pinnedAt);
      expect(model.position('n004')).toEqual({ x: 900, y: 900 });
    }
  });

  it('pulls a neighbor after an entity held elsewhere, and goes still again once it is released and the rest settle', () => {
    const { ids, links, positions } = line(4);
    const model = createPhysics({ ids, links, positions, pinned: new Set() });
    settle(model);
    const before = model.position('n001') ?? { x: 0, y: 0 };
    model.hold('n000', { x: -2000, y: 0 });
    for (let frame = 0; frame < 120; frame += 1) model.step();
    const during = model.position('n001') ?? { x: 0, y: 0 };
    expect(during.x).toBeLessThan(before.x - 100);
    model.release('n000');
    expect(model.settled).toBe(false);
    expect(settle(model)).toBeLessThan(3000);
  });

  it('gives the same result for the same input, and separates two entities at the same spot', () => {
    const input = { ids: ['a', 'b'], links: [] as [string, string][], positions: new Map([['a', { x: 0, y: 0 }], ['b', { x: 0, y: 0 }]]), pinned: new Set<string>() };
    const one = createPhysics(input);
    const two = createPhysics(input);
    for (let frame = 0; frame < 30; frame += 1) {
      one.step();
      two.step();
    }
    expect(one.positions()).toEqual(two.positions());
    const a = one.position('a') ?? { x: 0, y: 0 };
    const b = one.position('b') ?? { x: 0, y: 0 };
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(10);
  });

  it('ignores relationships to entities it does not hold and takes no part for entities it is not given', () => {
    const model = createPhysics({ ids: ['a', 'b'], links: [['a', 'ghost'], ['a', 'a']], positions: new Map([['a', { x: 0, y: 0 }], ['b', { x: 300, y: 0 }]]), pinned: new Set() });
    model.step();
    expect(model.has('ghost')).toBe(false);
    expect([...model.positions().keys()]).toEqual(['a', 'b']);
  });
});
