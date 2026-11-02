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
  it('reads a source that answered as reachable, one that did not as unreachable, and a run that did not settle, or no result, as unknown', () => {
    const cache = createReachabilityCache(['a', 'b', 'c', 'd', 'e', 'f']);
    seedFromStartup(
      cache,
      [
        { sourceId: 'a', outcome: 'pass', answered: true, findings: [] },
        { sourceId: 'b', outcome: 'warn', answered: true, findings: [] },
        { sourceId: 'c', outcome: 'fail', answered: false, findings: [] },
        { sourceId: 'd', outcome: 'error', answered: false, findings: [] },
        { sourceId: 'f', outcome: 'fail', answered: true, findings: [{ severity: 'fail', check: 'label', message: 'a wrong mapping' }] },
      ],
    );
    expect([cache.get('a'), cache.get('b'), cache.get('c'), cache.get('d'), cache.get('e'), cache.get('f')]).toEqual(['reachable', 'reachable', 'unreachable', 'unknown', 'unknown', 'reachable']);
    expect(cache.counts()).toEqual({ reachable: 3, unreachable: 1, unknown: 2 });
  });

  it('reads a source that answered the capabilities read but whose later read did not settle as reachable', () => {
    const cache = createReachabilityCache(['a']);
    seedFromStartup(cache, [{ sourceId: 'a', outcome: 'error', answered: true, findings: [] }]);
    expect(cache.get('a')).toBe('reachable');
  });
});
