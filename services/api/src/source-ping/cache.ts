import type { SourceReachability } from '@neburyx/contracts';
import type { StartupResult } from '../source-test/startup.js';

export type Reachability = 'reachable' | 'unreachable' | 'unknown';

/** The read-only view of the cache that the application is given: counts of the configured sources, nothing per source. */
export interface ReachabilityView {
  counts(): SourceReachability;
}

export interface ReachabilityCache extends ReachabilityView {
  get(sourceId: string): Reachability;
  set(sourceId: string, state: Reachability): void;
}

export function createReachabilityCache(sourceIds: readonly string[]): ReachabilityCache {
  const states = new Map<string, Reachability>(sourceIds.map((id) => [id, 'unknown']));
  return {
    get: (sourceId) => states.get(sourceId) ?? 'unknown',
    set(sourceId, state) {
      if (states.has(sourceId)) states.set(sourceId, state);
    },
    counts() {
      const counts = { reachable: 0, unreachable: 0, unknown: 0 };
      for (const state of states.values()) counts[state] += 1;
      return counts;
    },
  };
}

/** A view for an application that has no cache: every configured source is unknown. */
export function allUnknown(sourceCount: number): ReachabilityView {
  return { counts: () => ({ reachable: 0, unreachable: 0, unknown: sourceCount }) };
}

/** The startup check answered with a report (`pass`, `warn`) or with a failure of the source (`fail`); `error` says nothing about the source. */
export function seedFromStartup(cache: ReachabilityCache, results: readonly StartupResult[]): void {
  for (const result of results) {
    if (result.outcome !== 'error') cache.set(result.sourceId, result.outcome === 'fail' ? 'unreachable' : 'reachable');
  }
}
