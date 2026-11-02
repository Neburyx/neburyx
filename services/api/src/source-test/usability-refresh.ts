import type { CheckedSource, QualifyingCheck } from '../db/source-checks-repository.js';
import type { MappingModel } from '../mapping/model.js';
import { identityHashOf } from '../registry/identity-hash.js';
import type { UsabilityRecord } from './usability.js';

export interface UsabilityStore {
  latestQualifyingChecks(sources: readonly CheckedSource[], since: string, onUnreadable?: (sourceId: string) => void): Promise<QualifyingCheck[]>;
}

export interface UsabilityLogger {
  warn(fields: object, message: string): void;
}

/**
 * Takes the verdicts of the checks that other processes (the command, another API copy of the same mapping) stored since this process started, with one query to Postgres.
 * A failure keeps what the record holds and is logged without detail.
 */
export async function refreshUsability(store: UsabilityStore, record: UsabilityRecord, mapping: MappingModel, since: string, logger: UsabilityLogger): Promise<void> {
  const sources = mapping.sources.map((source): CheckedSource => ({ id: source.id, identityHash: identityHashOf(source), configHash: source.configHash }));
  try {
    const checks = await store.latestQualifyingChecks(sources, since, (sourceId) => logger.warn({ event: 'source.usability_row_unreadable', sourceId }, 'a stored check could not be read'));
    for (const check of checks) record.observe(check.report);
  } catch {
    logger.warn({ event: 'source.usability_refresh_failed' }, 'source usability refresh failed');
  }
}
