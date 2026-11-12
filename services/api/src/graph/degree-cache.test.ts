import type { DegreePreview } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createDegreeCache, type DegreeCacheKey } from './degree-cache.js';

const key = (overrides: Partial<DegreeCacheKey> = {}): DegreeCacheKey => ({ sourceId: 'alpha', configHash: 'h1', principalId: 'p1', entityType: 'person', stableId: 'P-1', mask: false, verdictRevision: 0, ...overrides });
const preview = (stableId: string): DegreePreview => ({ ref: { sourceId: 'alpha', entityType: 'person', stableId }, total: { value: 0, quality: 'exact', scope: 'x' }, byType: [], byNeighborType: [], warnings: [], pageSize: 25, heavyOpThreshold: 500 });
const clockAt = () => {
  let now = 0;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
};

describe('the degree preview cache', () => {
  it('serves an answer stored for the same key within its lifetime', () => {
    const clock = clockAt();
    const cache = createDegreeCache({ lifetimeMs: 1000, clock: clock.now });
    cache.set(key(), preview('P-1'));
    clock.advance(999);
    expect(cache.get(key())).toEqual(preview('P-1'));
  });

  it('serves nothing at or after the end of the lifetime', () => {
    const clock = clockAt();
    const cache = createDegreeCache({ lifetimeMs: 1000, clock: clock.now });
    cache.set(key(), preview('P-1'));
    clock.advance(1000);
    expect(cache.get(key())).toBeUndefined();
  });

  it.each([
    ['another mask setting', { mask: true }],
    ['another person', { principalId: 'p2' }],
    ['another source', { sourceId: 'beta' }],
    ['another node', { stableId: 'P-2' }],
    ['another entity type', { entityType: 'order_line' }],
    ['another mapping', { configHash: 'h2' }],
    ['another degree verdict', { verdictRevision: 1 }],
  ])('does not serve an answer stored for %s', (_name, other) => {
    const cache = createDegreeCache();
    cache.set(key(), preview('P-1'));
    expect(cache.get(key(other))).toBeUndefined();
  });

  it('never serves a masked answer to an unmasked request, nor the reverse', () => {
    const cache = createDegreeCache();
    cache.set(key({ mask: true }), preview('masked'));
    expect(cache.get(key({ mask: false }))).toBeUndefined();
    cache.set(key({ mask: false }), preview('plain'));
    expect(cache.get(key({ mask: true }))?.ref.stableId).toBe('masked');
    expect(cache.get(key({ mask: false }))?.ref.stableId).toBe('plain');
  });

  it('never holds more than the bound, and drops the one used least recently', () => {
    const cache = createDegreeCache({ maxEntries: 2 });
    cache.set(key({ stableId: 'a' }), preview('a'));
    cache.set(key({ stableId: 'b' }), preview('b'));
    expect(cache.get(key({ stableId: 'a' }))).toBeDefined();
    cache.set(key({ stableId: 'c' }), preview('c'));
    expect(cache.size()).toBe(2);
    expect(cache.get(key({ stableId: 'b' }))).toBeUndefined();
    expect(cache.get(key({ stableId: 'a' }))).toBeDefined();
    expect(cache.get(key({ stableId: 'c' }))).toBeDefined();
  });
});

describe('the degree preview cache read by coverage', () => {
  const IDLE = 5 * 60 * 1000;
  const MAX_AGE = 60 * 60 * 1000;
  const rig = () => {
    const clock = clockAt();
    const cache = createDegreeCache({ lifetimeMs: IDLE, coverageMaxAgeMs: MAX_AGE, clock: clock.now });
    cache.set(key(), preview('P-1'));
    return { clock, cache };
  };

  it('still counts a preview after five minutes of use, when each use is within the idle time', () => {
    const { clock, cache } = rig();
    for (let use = 0; use < 10; use += 1) {
      clock.advance(IDLE - 1000);
      expect(cache.getForCoverage(key())).toEqual(preview('P-1'));
    }
  });

  it('stops counting a preview that coverage did not use for the idle time', () => {
    const { clock, cache } = rig();
    clock.advance(IDLE - 1);
    expect(cache.getForCoverage(key())).toEqual(preview('P-1'));
    clock.advance(IDLE);
    expect(cache.getForCoverage(key())).toBeUndefined();
  });

  it('stops counting a preview at the maximum age of its read, however it is used', () => {
    const { clock, cache } = rig();
    let counted = true;
    while (clock.now() < MAX_AGE - IDLE / 2) {
      clock.advance(IDLE / 2);
      counted = cache.getForCoverage(key()) !== undefined;
      expect(counted).toBe(true);
    }
    clock.advance(IDLE / 2);
    expect(cache.getForCoverage(key())).toBeUndefined();
  });

  it('starts a new age when the preview is read again', () => {
    const { clock, cache } = rig();
    clock.advance(MAX_AGE - 1000);
    cache.set(key(), preview('P-1'));
    clock.advance(IDLE - 1);
    expect(cache.getForCoverage(key())).toEqual(preview('P-1'));
  });

  it('serves a preview request only within five minutes of the read, while coverage still counts the preview', () => {
    const { clock, cache } = rig();
    clock.advance(IDLE - 1000);
    expect(cache.getForCoverage(key())).toEqual(preview('P-1'));
    clock.advance(1001);
    expect(cache.get(key())).toBeUndefined();
    expect(cache.getForCoverage(key())).toEqual(preview('P-1'));
  });

  it('does not renew a preview for coverage when a preview request is served from it', () => {
    const { clock, cache } = rig();
    clock.advance(IDLE - 1000);
    expect(cache.get(key())).toEqual(preview('P-1'));
    clock.advance(1001);
    expect(cache.getForCoverage(key())).toBeUndefined();
  });

  it.each([
    ['another mask setting', { mask: true }],
    ['another person', { principalId: 'p2' }],
    ['another source', { sourceId: 'beta' }],
    ['another mapping', { configHash: 'h2' }],
    ['another degree verdict', { verdictRevision: 1 }],
  ])('does not count a preview stored for %s', (_name, other) => {
    const { cache } = rig();
    expect(cache.getForCoverage(key(other))).toBeUndefined();
  });
});
