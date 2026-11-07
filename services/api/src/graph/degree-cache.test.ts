import type { DegreePreview } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createDegreeCache, type DegreeCacheKey } from './degree-cache.js';

const key = (overrides: Partial<DegreeCacheKey> = {}): DegreeCacheKey => ({ sourceId: 'alpha', configHash: 'h1', principalId: 'p1', entityType: 'person', stableId: 'P-1', mask: false, verdictRevision: 0, ...overrides });
const preview = (stableId: string): DegreePreview => ({ ref: { sourceId: 'alpha', entityType: 'person', stableId }, total: { value: 0, quality: 'exact', scope: 'x' }, byType: [], byNeighborType: [], warnings: [] });
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
    expect(cache.size()).toBe(0);
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
