import type { FastifyBaseLogger } from 'fastify';
import type { PurgedInvestigation } from '../db/investigations-repository.js';
import type { AuditSink } from '../seams/seams.js';
import type { Task } from './tasks.js';

/** What the purge needs of the store: the deletion of what has passed its purge date. */
export interface PurgeStore {
  purgeExpiredInvestigations(beforeDelete: (purged: PurgedInvestigation) => Promise<void>): Promise<number>;
}

export interface MaintenanceDeps {
  readonly store: PurgeStore;
  readonly audit: AuditSink;
  readonly logger: FastifyBaseLogger;
}

const PURGE_TASK = 'purge-deleted-investigations';
/** Every day at 03:17; the minute is off the hour so copies of other products do not all start together. */
const PURGE_SCHEDULE = '17 3 * * *';

/** Removes the investigations whose purge date has passed, and what hangs off them. It is safe to run twice and at the same moment: each investigation is taken under a lock and deleted once. */
export async function purgeDeletedInvestigations(deps: MaintenanceDeps): Promise<number> {
  const purged = await deps.store.purgeExpiredInvestigations(async ({ sourceId }) => {
    await deps.audit.record({ actorId: 'system', actorRole: 'system', action: 'investigation.purge', traceId: 'purge', result: 'success', sourceId });
  });
  deps.logger.info({ event: 'investigation.purged', count: purged }, 'deleted investigations purged');
  return purged;
}

export function maintenanceTasks(deps: MaintenanceDeps): readonly Task[] {
  return [{ name: PURGE_TASK, schedule: PURGE_SCHEDULE, run: async () => void (await purgeDeletedInvestigations(deps)) }];
}
