import { CONNECTIVITY_ID } from '../gate/templates/connectivity.js';
import type { Clock, SystemRunner } from '../gate/types.js';
import type { MappingModel } from '../mapping/model.js';
import { FAILURE_SENTENCES, failureReasonOf } from '../source-test/reasons.js';
import type { Reachability, ReachabilityCache } from './cache.js';

/** What one run found for one source; `skipped` means the run said nothing about the source and the cache kept what it held. */
export interface PingResult {
  readonly sourceId: string;
  readonly previous: Reachability;
  readonly current: Reachability;
  readonly reason: string | null;
  readonly skipped: boolean;
  /** True when the source went from unreachable or unknown to reachable. */
  readonly recovered: boolean;
  /** The clock time at which the read of this source started. */
  readonly startedAt: number;
}

export interface PingCounters {
  readonly attempts: number;
  readonly reachable: number;
  readonly unreachable: number;
  readonly skipped: number;
}

export interface PingMetrics {
  snapshot(): Readonly<Record<string, PingCounters>>;
}

export interface ScheduledPingDeps {
  readonly system: SystemRunner;
  readonly mapping: MappingModel;
  readonly cache: ReachabilityCache;
  readonly clock?: Clock;
}

export interface ScheduledPing {
  run(): Promise<readonly PingResult[]>;
  readonly metrics: PingMetrics;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Asks every mapped source at once whether it answers, through the system runner and the fixed connectivity template, and keeps the answer in the cache. */
export function createScheduledPing(deps: ScheduledPingDeps): ScheduledPing {
  const clock = deps.clock ?? Date.now;
  const counters = new Map<string, Mutable<PingCounters>>(deps.mapping.sources.map((source) => [source.id, { attempts: 0, reachable: 0, unreachable: 0, skipped: 0 }]));

  async function pingOne(sourceId: string): Promise<PingResult> {
    const startedAt = clock();
    const previous = deps.cache.get(sourceId);
    const count = counters.get(sourceId);
    if (count !== undefined) count.attempts += 1;
    let current: Reachability;
    let reason: string | null = null;
    try {
      await deps.system.run({ traceId: `tr-ping-${sourceId}`, sourceId, templateId: CONNECTIVITY_ID, params: {}, limit: 1 });
      current = 'reachable';
    } catch (error) {
      const failure = failureReasonOf(error);
      if (failure === undefined) {
        if (count !== undefined) count.skipped += 1;
        return { sourceId, previous, current: previous, reason: null, skipped: true, recovered: false, startedAt };
      }
      current = 'unreachable';
      reason = FAILURE_SENTENCES[failure];
    }
    if (count !== undefined) count[current] += 1;
    deps.cache.set(sourceId, current);
    return { sourceId, previous, current, reason, skipped: false, recovered: current === 'reachable' && previous !== 'reachable', startedAt };
  }

  return {
    run: () => Promise.all(deps.mapping.sources.map((source) => pingOne(source.id))),
    metrics: { snapshot: () => Object.fromEntries([...counters].map(([id, count]) => [id, { ...count }])) },
  };
}
