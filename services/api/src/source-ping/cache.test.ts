import { describe, expect, it } from 'vitest';
import { allUnknown, createReachabilityCache, seedFromStartup } from './cache.js';

describe('the reachability cache', () => {
  it('starts with every configured source unknown', () => {
    const cache = createReachabilityCache(['alpha', 'beta']);
    expect(cache.counts()).toEqual({ reachable: 0, unreachable: 0, unknown: 2 });
    expect(cache.get('alpha')).toBe('unknown');
  });

  it('counts exactly the configured sources by what was found, and ignores a source it was not given', () => {
    const cache = createReachabilityCache(['alpha', 'beta', 'gamma']);
    cache.set('alpha', 'reachable');
    cache.set('beta', 'unreachable');
    cache.set('other', 'reachable');
    expect(cache.counts()).toEqual({ reachable: 1, unreachable: 1, unknown: 1 });
    expect(cache.get('beta')).toBe('unreachable');
  });

  it('counts nothing for a mapping with no source', () => {
    expect(createReachabilityCache([]).counts()).toEqual({ reachable: 0, unreachable: 0, unknown: 0 });
  });

  it('gives a view of unknown sources to an application that has no cache', () => {
    expect(allUnknown(2).counts()).toEqual({ reachable: 0, unreachable: 0, unknown: 2 });
  });
});

describe('seeding from the startup check', () => {
  it('reads pass and warn as reachable, fail as unreachable, and error or no result as unknown', () => {
    const cache = createReachabilityCache(['a', 'b', 'c', 'd', 'e']);
    seedFromStartup(
      cache,
      [
        { sourceId: 'a', outcome: 'pass' },
        { sourceId: 'b', outcome: 'warn' },
        { sourceId: 'c', outcome: 'fail' },
        { sourceId: 'd', outcome: 'error' },
      ],
    );
    expect([cache.get('a'), cache.get('b'), cache.get('c'), cache.get('d'), cache.get('e')]).toEqual(['reachable', 'reachable', 'unreachable', 'unknown', 'unknown']);
    expect(cache.counts()).toEqual({ reachable: 2, unreachable: 1, unknown: 2 });
  });
});
