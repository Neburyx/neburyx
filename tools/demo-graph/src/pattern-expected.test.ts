import { describe, expect, it } from 'vitest';
import { expectedReach } from './pattern-expected.js';

const edges = [
  { f: 'a', t: 'b' },
  { f: 'a', t: 'c' },
  { f: 'b', t: 'c' },
  { f: 'c', t: 'a' },
  { f: 'd', t: 'a' },
];

describe('the set a pattern is expected to reach, computed from an export', () => {
  it('is the entities one step reaches, in the direction of the step, and never the anchor', () => {
    expect(expectedReach('node', 'a', [{ edges, direction: 'out', arrivesAt: 'node' }])).toEqual(new Set(['b', 'c']));
    expect(expectedReach('node', 'a', [{ edges, direction: 'in', arrivesAt: 'node' }])).toEqual(new Set(['c', 'd']));
  });

  it('is the entities the second step reaches, with no entity twice on a path', () => {
    expect(expectedReach('node', 'a', [{ edges, direction: 'out', arrivesAt: 'node' }, { edges, direction: 'out', arrivesAt: 'node' }])).toEqual(new Set(['c']));
  });

  it('goes out to one type and back in to another, and never returns to the anchor', () => {
    const lives = [{ f: 'p1', t: 'h1' }, { f: 'p2', t: 'h1' }, { f: 'p3', t: 'h1' }, { f: 'p1', t: 'h2' }, { f: 'p4', t: 'h2' }, { f: 'p5', t: 'h3' }];
    const steps = [{ edges: lives, direction: 'out', arrivesAt: 'home' }, { edges: lives, direction: 'in', arrivesAt: 'person' }] as const;
    expect(expectedReach('person', 'p1', steps)).toEqual(new Set(['p2', 'p3', 'p4']));
    expect(expectedReach('person', 'p5', steps)).toEqual(new Set());
  });

  it('keeps a later transfer only when it is not earlier than the one before and, with a delay, not later than that plus the delay (both ends included)', () => {
    const HOUR = 3_600_000;
    const timed = [
      { f: 'a', t: 'b', at: 0 },
      { f: 'b', t: 'zero', at: 0 },
      { f: 'b', t: 'edge', at: 24 * HOUR },
      { f: 'b', t: 'late', at: 24 * HOUR + 60_000 },
      { f: 'b', t: 'before', at: -HOUR },
      { f: 'b', t: 'undated', at: undefined },
    ];
    const first = { edges: timed, direction: 'out' as const, arrivesAt: 'node' };
    expect(expectedReach('node', 'a', [first, { ...first, ordered: true }])).toEqual(new Set(['zero', 'edge', 'late']));
    expect(expectedReach('node', 'a', [first, { ...first, ordered: true, withinMinutes: 1440 }])).toEqual(new Set(['zero', 'edge']));
  });
});
