import type { PingStateChange } from '../db/source-checks-repository.js';
import type { PingResult } from './ping.js';

export interface PingStateStore {
  applyPingState(change: PingStateChange): Promise<boolean>;
}

export interface PingStateLogger {
  warn(fields: object, message: string): void;
}

/**
 * Writes the state each ping implies for its source; a skipped ping implies none. A write that fails is logged once with the source ID
 * and does not stop the others; the next run tries again.
 */
export async function applyPingResults(store: PingStateStore, logger: PingStateLogger, results: readonly PingResult[]): Promise<void> {
  await Promise.all(
    results
      .filter((result) => !result.skipped)
      .map(async (result) => {
        try {
          await store.applyPingState({ sourceId: result.sourceId, reachable: result.current === 'reachable', reason: result.reason, observedAt: new Date(result.startedAt).toISOString() });
        } catch {
          logger.warn({ event: 'source.ping_state_failed', sourceId: result.sourceId }, 'source ping state write failed');
        }
      }),
  );
}
