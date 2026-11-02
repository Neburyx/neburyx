import type { Clock, SystemRunner } from '../gate/types.js';
import type { MappingModel } from '../mapping/model.js';
import type { PingResult } from '../source-ping/ping.js';
import { checkSource, type CheckStore } from './check.js';
import type { UsabilityRecord } from './usability.js';

/** The longest a source that cannot be settled waits between two attempts. */
export const MAX_BACKOFF_MS = 10 * 60 * 1000;

export interface FirstContactDeps {
  readonly system: SystemRunner;
  readonly mapping: MappingModel;
  readonly store: CheckStore;
  readonly record: UsabilityRecord;
  readonly clock?: Clock;
  readonly logger: { warn(fields: object, message: string): void };
  /** The time between two ticks of the ping, which the back-off counts in. */
  readonly intervalMs: number;
}

export interface FirstContact {
  /** Called after each tick and the refresh of the record: starts the check of every source that answered and has none that settled. */
  afterTick(results: readonly PingResult[]): void;
  /** Starts no new check. */
  stop(): void;
  /** Resolves when the checks that were already running have ended. */
  drain(): Promise<void>;
}

interface Attempts {
  /** Ticks to let pass before the next attempt. */
  skip: number;
  /** Failed attempts in a row. */
  failures: number;
}

/**
 * Runs the whole check for a source that answered a ping and has no check that settled since this process started, outside the tick so that the pings of the other
 * sources go on, with at most one check in flight for a source. A check that does not settle stores nothing; it is logged once with the source ID, and the next
 * attempt waits twice as many ticks as the last, up to ten minutes.
 */
export function createFirstContact(deps: FirstContactDeps): FirstContact {
  const clock = deps.clock ?? Date.now;
  const inFlight = new Map<string, Promise<void>>();
  const attempts = new Map<string, Attempts>();
  const maxSkip = Math.max(0, Math.floor(MAX_BACKOFF_MS / deps.intervalMs) - 1);
  let stopped = false;

  async function attempt(sourceId: string): Promise<void> {
    const source = deps.mapping.sources.find((candidate) => candidate.id === sourceId);
    if (source === undefined) return;
    try {
      await checkSource({ store: deps.store, clock, logger: deps.logger }, source, (request) => deps.system.run(request), `tr-first-contact-${sourceId}`, null);
      attempts.delete(sourceId);
    } catch {
      const failures = (attempts.get(sourceId)?.failures ?? 0) + 1;
      attempts.set(sourceId, { failures, skip: Math.min(2 ** (failures - 1) - 1, maxSkip) });
      deps.logger.warn({ event: 'source.first_contact_failed', sourceId }, 'source first-contact check failed');
    }
  }

  return {
    afterTick(results) {
      if (stopped) return;
      for (const result of results) {
        if (result.skipped || result.current !== 'reachable' || inFlight.has(result.sourceId)) continue;
        if (deps.record.verdictOf(result.sourceId) !== 'unchecked') {
          attempts.delete(result.sourceId);
          continue;
        }
        const waiting = attempts.get(result.sourceId);
        if (waiting !== undefined && waiting.skip > 0) {
          attempts.set(result.sourceId, { ...waiting, skip: waiting.skip - 1 });
          continue;
        }
        const running = attempt(result.sourceId).finally(() => inFlight.delete(result.sourceId));
        inFlight.set(result.sourceId, running);
      }
    },
    stop() {
      stopped = true;
    },
    async drain() {
      await Promise.all([...inFlight.values()]);
    },
  };
}
