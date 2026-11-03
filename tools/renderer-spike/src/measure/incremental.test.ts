import { describe, expect, it } from 'vitest';
import type { Position } from '../adapter.js';
import { generateFixture } from '../fixture/generate.js';
import { stubAdapter } from '../testing/stub-adapter.js';
import type { Clock } from './clock.js';
import { FRAMES_AFTER_ADD, MANUAL_NODES, PINNED_NODES, compareMoves, measureIncremental } from './incremental.js';

interface FakeClock extends Clock {
  advance(ms: number): void;
}

function fakeClock(frameMs: number): FakeClock {
  let time = 1000;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
    nextFrame(callback) {
      time += frameMs;
      callback(time);
    },
  };
}

describe('compareMoves', () => {
  const before = new Map<string, Position>([
    ['a', { x: 0, y: 0 }],
    ['b', { x: 10, y: 10 }],
    ['c', { x: 5, y: 5 }],
  ]);

  it('counts a node as moved when either coordinate differs, with no tolerance, and reports displacement of the movers', () => {
    const after = new Map<string, Position>([
      ['a', { x: 3, y: 4 }],
      ['b', { x: 10, y: 10.0000001 }],
      ['c', { x: 5, y: 5 }],
    ]);
    const result = compareMoves(before, after, ['a', 'b', 'c']);
    expect(result.total).toBe(3);
    expect(result.moved).toBe(2);
    expect(result.maxDisplacement).toBe(5);
    expect(result.medianDisplacement).toBeCloseTo(2.5, 6);
  });

  it('takes the median of an even number of movers as the mean of the two middle displacements', () => {
    const after = new Map<string, Position>([
      ['a', { x: 1, y: 0 }],
      ['b', { x: 15, y: 10 }],
      ['c', { x: 5, y: 5 }],
    ]);
    expect(compareMoves(before, after, ['a', 'b']).medianDisplacement).toBe(3);
  });

  it('reports no displacement when nothing moved', () => {
    expect(compareMoves(before, before, ['a', 'b'])).toEqual({ total: 2, moved: 0, medianDisplacement: 0, maxDisplacement: 0 });
  });

  it('refuses a node whose position is missing, naming a code and not the node', () => {
    const after = new Map<string, Position>([['a', { x: 0, y: 0 }]]);
    expect(() => compareMoves(before, after, ['a', 'b'])).toThrowError(expect.objectContaining({ code: 'POSITIONS_UNAVAILABLE' }));
    expect(() => compareMoves(before, after, ['a', 'b'])).not.toThrowError(/b/);
  });
});

describe('measureIncremental', () => {
  const fixture = generateFixture({ seed: 1 });
  const start = new Map<string, Position>(fixture.nodes.map((node, index) => [node.id, { x: index, y: index * 2 }]));

  it('reports the known moved set by kind: nothing manual or pinned moves, only chosen unpinned nodes do', async () => {
    const adapter = stubAdapter({
      positions: start,
      onAddNodes: (positions, _additions, fixed) => {
        let shifted = 0;
        for (const node of fixture.nodes) {
          if (fixed.has(node.id) || shifted >= 7) continue;
          const position = positions.get(node.id);
          if (position !== undefined) positions.set(node.id, { x: position.x + 1, y: position.y });
          shifted += 1;
        }
      },
    });
    const result = await measureIncremental(adapter, fixture, fakeClock(20));
    expect(result.manual).toMatchObject({ total: MANUAL_NODES, moved: 0 });
    expect(result.pinned).toMatchObject({ total: PINNED_NODES, moved: 0 });
    expect(result.unpinned.moved).toBe(7);
    expect(result.unpinned.total).toBe(fixture.nodes.length - MANUAL_NODES - PINNED_NODES);
    expect(result.addedNodes).toBe(25);
    expect(result.drawnAfter - result.drawnBefore).toBe(25);
    expect(result.holdMechanism).toBe('stub lock');
  });

  it('measures the time the add blocked and the frames that follow it, with the blocked time in the first interval', async () => {
    const clock = fakeClock(20);
    const adapter = stubAdapter({ positions: start, onAddNodes: () => clock.advance(100) });
    const result = await measureIncremental(adapter, fixture, clock);
    expect(result.addDurationMs).toBe(100);
    expect(result.longestFrameMs).toBe(120);
    expect(result.frames.frames).toBe(FRAMES_AFTER_ADD);
    expect(result.frames.medianFps).toBe(50);
    expect(result.frames.p5Fps).toBeCloseTo(1000 / 20, 5);
  });

  it('reports held nodes that moved when the adapter does not keep them', async () => {
    const adapter = stubAdapter({
      positions: start,
      onAddNodes: (positions) => {
        for (const [id, position] of positions) positions.set(id, { x: position.x + 1, y: position.y });
        for (const node of fixture.nodes) if (!positions.has(node.id)) positions.set(node.id, { x: 0, y: 0 });
      },
    });
    const result = await measureIncremental(adapter, fixture, fakeClock(20));
    expect(result.manual.moved).toBe(MANUAL_NODES);
    expect(result.pinned.moved).toBe(PINNED_NODES);
  });

  it('fails with a named error when the adapter cannot read positions of the original nodes', async () => {
    const adapter = stubAdapter({ positions: new Map() });
    await expect(measureIncremental(adapter, fixture, fakeClock(20))).rejects.toMatchObject({ code: 'POSITIONS_UNAVAILABLE' });
  });

  it('rejects, and does not hang, when the add throws inside a frame the clock delivers later', async () => {
    let time = 1000;
    const queued: Clock = {
      now: () => time,
      nextFrame(callback) {
        queueMicrotask(() => {
          time += 20;
          callback(time);
        });
      },
    };
    const adapter = stubAdapter({ positions: start, onAddNodes: () => { throw new Error('layout crashed'); } });
    await expect(measureIncremental(adapter, fixture, queued)).rejects.toThrowError('layout crashed');
  });

  it('propagates an error thrown while the nodes are added', async () => {
    const adapter = stubAdapter({ positions: start, onAddNodes: () => { throw new Error('layout crashed'); } });
    await expect(measureIncremental(adapter, fixture, fakeClock(20))).rejects.toThrowError('layout crashed');
  });
});
