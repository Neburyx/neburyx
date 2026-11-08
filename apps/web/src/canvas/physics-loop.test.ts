import { describe, expect, it, vi } from 'vitest';
import type { Position } from '../state/presentation-state.js';
import { PhysicsLoop, type Clock, type PhysicsHost } from './physics-loop.js';
import { keys } from './layout-test-kit.js';
import { PHYSICS_FULL_RATE_ENTITIES } from './layout-constants.js';

function fakeClock() {
  let next = 1;
  let visible = true;
  const waiting = new Map<number, () => void>();
  const clock: Clock = {
    request: (frame) => {
      const handle = next;
      next += 1;
      waiting.set(handle, frame);
      return handle;
    },
    cancel: (handle) => void waiting.delete(handle),
    visible: () => visible,
  };
  return {
    clock,
    pending: () => waiting.size,
    tick: () => {
      const [handle, frame] = [...waiting][0] ?? [];
      if (handle === undefined || frame === undefined) return false;
      waiting.delete(handle);
      frame();
      return true;
    },
    hide: () => {
      visible = false;
    },
    show: () => {
      visible = true;
    },
  };
}

function setup(options: { pinned?: string[]; failPlace?: boolean } = {}) {
  const ids = keys(5);
  const links = ids.slice(1).map((id, index) => [ids[index] ?? '', id] as [string, string]);
  const positions = new Map(ids.map((id, index) => [id, { x: index * 120, y: index % 2 ? 20 : 0 }] as const));
  const placed: ReadonlyMap<string, Position>[] = [];
  const commits: ReadonlyMap<string, Position>[] = [];
  const failures: ReadonlyMap<string, Position>[] = [];
  const host: PhysicsHost = {
    place: (given) => {
      if (options.failPlace === true) throw new Error('cannot draw');
      placed.push(given);
    },
    commit: (given) => void commits.push(given),
    failed: (given) => void failures.push(given),
  };
  const fake = fakeClock();
  const loop = new PhysicsLoop(host, fake.clock);
  loop.configure({ ids, links, positions, pinned: new Set(options.pinned ?? []), followers: [] });
  return { loop, fake, ids, placed, commits, failures };
}

const run = (fake: ReturnType<typeof fakeClock>, limit = 5000): number => {
  let frames = 0;
  while (frames < limit && fake.tick()) frames += 1;
  return frames;
};

describe('the live force loop', () => {
  it('computes frames while the entities move, goes idle when they settle, stores the positions once, and computes nothing more', () => {
    const { fake, loop, commits } = setup();
    const frames = run(fake);
    expect(frames).toBeGreaterThan(1);
    expect(frames).toBeLessThan(5000);
    expect(commits).toHaveLength(1);
    expect(fake.pending()).toBe(0);
    expect(loop.running).toBe(false);
    const computed = loop.frames;
    expect(fake.tick()).toBe(false);
    expect(loop.frames).toBe(computed);
  });

  it('stops within one frame when it is stopped, and stores what the entities had', () => {
    const { fake, loop, commits } = setup();
    fake.tick();
    fake.tick();
    loop.stop();
    expect(fake.pending()).toBe(0);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.size).toBeGreaterThan(0);
    expect(loop.running).toBe(false);
  });

  it('computes no frame while the document is hidden and goes on when it is visible again', () => {
    const { fake, loop } = setup();
    fake.tick();
    fake.hide();
    loop.visibility();
    expect(fake.pending()).toBe(0);
    const frames = loop.frames;
    expect(fake.tick()).toBe(false);
    expect(loop.frames).toBe(frames);
    fake.show();
    loop.visibility();
    expect(fake.pending()).toBe(1);
    fake.tick();
    expect(loop.frames).toBe(frames + 1);
  });

  it('does not start a frame at all when the document is hidden from the start', () => {
    const fake = fakeClock();
    fake.hide();
    const loop = new PhysicsLoop({ place: () => undefined, commit: () => undefined, failed: () => undefined }, fake.clock);
    loop.configure({ ids: ['a', 'b'], links: [['a', 'b']], positions: new Map([['a', { x: 0, y: 0 }], ['b', { x: 400, y: 0 }]]), pinned: new Set(), followers: [] });
    expect(fake.pending()).toBe(0);
  });

  it('pulls the neighbors of a held entity frame by frame, and never moves a pinned one', () => {
    const { fake, loop, placed } = setup({ pinned: ['n004'] });
    run(fake);
    const settled = placed[placed.length - 1];
    loop.drag('n000', { x: -1500, y: 0 });
    const before = placed.length;
    for (let frame = 0; frame < 40; frame += 1) fake.tick();
    expect(placed.length).toBeGreaterThan(before);
    const after = placed[placed.length - 1];
    expect(after?.get('n001')?.x).toBeLessThan((settled?.get('n001')?.x ?? 0) - 50);
    expect(after?.has('n000')).toBe(false);
    for (const frame of placed.slice(before)) expect(frame.get('n004')).toEqual(settled?.get('n004'));
  });

  it('wakes for a position stored from outside, and for a drag that ends, and settles again', () => {
    const { fake, loop, commits } = setup();
    run(fake);
    expect(fake.pending()).toBe(0);
    loop.external(new Map([['n002', { x: 900, y: 900 }]]));
    expect(fake.pending()).toBe(1);
    run(fake);
    expect(commits).toHaveLength(2);
    loop.drag('n001', { x: 5, y: 5 });
    loop.drag('n001', undefined);
    expect(fake.pending()).toBe(1);
  });

  it('stops and reports the positions of the last frame drawn when a frame cannot be drawn', () => {
    const { fake, failures, loop } = setup({ failPlace: true });
    fake.tick();
    expect(failures).toHaveLength(1);
    expect(fake.pending()).toBe(0);
    expect(loop.running).toBe(false);
  });

  it('keeps an aggregate node at its offset from the entity it belongs to', () => {
    const fake = fakeClock();
    const given: ReadonlyMap<string, Position>[] = [];
    const loop = new PhysicsLoop({ place: (positions) => void given.push(positions), commit: () => undefined, failed: () => undefined }, fake.clock);
    loop.configure({ ids: ['a', 'b'], links: [['a', 'b']], positions: new Map([['a', { x: 0, y: 0 }], ['b', { x: 500, y: 0 }]]), pinned: new Set(), followers: [{ id: 'agg', owner: 'a', offset: { x: 10, y: 150 } }] });
    fake.tick();
    const frame = given[0];
    expect(frame?.get('agg')?.x).toBeCloseTo((frame?.get('a')?.x ?? 0) + 10);
    expect(frame?.get('agg')?.y).toBeCloseTo((frame?.get('a')?.y ?? 0) + 150);
  });

  it('survives being configured again with other entities', () => {
    const { loop, fake } = setup();
    fake.tick();
    const spy = vi.fn();
    loop.configure({ ids: ['x', 'y'], links: [['x', 'y']], positions: new Map([['x', { x: 0, y: 0 }], ['y', { x: 50, y: 0 }]]), pinned: new Set(), followers: [] });
    spy();
    expect(fake.pending()).toBe(1);
    run(fake);
    expect(loop.running).toBe(false);
  });

  it('draws every frame up to the full-rate count, every second frame above it, and computes a step in each', () => {
    const run2 = (count: number) => {
      const ids = keys(count);
      const fake = fakeClock();
      let drawn = 0;
      const loop = new PhysicsLoop({ place: () => void (drawn += 1), commit: () => undefined, failed: () => undefined }, fake.clock);
      loop.configure({ ids, links: [], positions: new Map(ids.map((id, index) => [id, { x: (index % 20) * 5, y: Math.floor(index / 20) * 5 }] as const)), pinned: new Set(), followers: [] });
      for (let frame = 0; frame < 20; frame += 1) fake.tick();
      return { drawn, frames: loop.frames };
    };
    expect(run2(PHYSICS_FULL_RATE_ENTITIES)).toEqual({ drawn: 20, frames: 20 });
    const above = run2(PHYSICS_FULL_RATE_ENTITIES + 1);
    expect(above.frames).toBe(20);
    expect(above.drawn).toBe(10);
  });

  it('puts an entity back at its start when its drag is cancelled, and does not keep it where it was held', () => {
    const { fake, loop, placed, commits } = setup();
    run(fake);
    const start = placed[placed.length - 1]?.get('n002') ?? { x: 0, y: 0 };
    loop.drag('n002', { x: 3000, y: 3000 });
    loop.cancelDrag('n002', start);
    run(fake);
    expect(placed[placed.length - 1]?.get('n002')?.x).toBeLessThan(2000);
    for (const stored of commits) expect(stored.get('n002')?.x ?? 0).toBeLessThan(2000);
  });

  it('takes the stored position of an entity that is pinned during a drag, never the held one', () => {
    const { fake, loop, ids, placed } = setup();
    loop.drag('n001', { x: 4000, y: 4000 });
    loop.configure({ ids, links: [], positions: new Map(ids.map((id, index) => [id, { x: index * 120, y: 0 }] as const)), pinned: new Set(['n001']), followers: [] });
    run(fake);
    for (const frame of placed) if (frame.has('n001')) expect(frame.get('n001')).toEqual({ x: 120, y: 0 });
  });

  it('reports the last frame drawn when a later frame cannot be drawn, and the stored positions when the first cannot', () => {
    const ids = keys(3);
    const positions = new Map(ids.map((id, index) => [id, { x: index * 100, y: 0 }] as const));
    const failures: ReadonlyMap<string, Position>[] = [];
    const given: ReadonlyMap<string, Position>[] = [];
    let good = 3;
    const fake = fakeClock();
    const loop = new PhysicsLoop(
      {
        place: (frame) => {
          if (good === 0) throw new Error('cannot draw');
          good -= 1;
          given.push(frame);
        },
        commit: () => undefined,
        failed: (last) => void failures.push(last),
      },
      fake.clock,
    );
    loop.configure({ ids, links: [['n000', 'n001']], positions, pinned: new Set(), followers: [] });
    run(fake);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.get('n000')).toEqual(given[2]?.get('n000'));
    const early = fakeClock();
    const first: ReadonlyMap<string, Position>[] = [];
    const broken = new PhysicsLoop({ place: () => { throw new Error('cannot draw'); }, commit: () => undefined, failed: (last) => void first.push(last) }, early.clock);
    broken.configure({ ids, links: [], positions, pinned: new Set(), followers: [] });
    early.tick();
    expect(first[0]).toEqual(positions);
  });

  it('computes no frame when it is configured again after a frame could not be drawn', () => {
    const fake = fakeClock();
    const loop = new PhysicsLoop({ place: () => { throw new Error('cannot draw'); }, commit: () => undefined, failed: () => undefined }, fake.clock);
    const graph = { ids: ['a', 'b'], links: [['a', 'b']] as [string, string][], positions: new Map([['a', { x: 0, y: 0 }], ['b', { x: 400, y: 0 }]]), pinned: new Set<string>(), followers: [] };
    loop.configure(graph);
    fake.tick();
    loop.configure(graph);
    expect(fake.pending()).toBe(0);
  });
});
