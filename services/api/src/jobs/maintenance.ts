import type { FastifyBaseLogger } from 'fastify';
import type { ExportStore } from '../db/exports-repository.js';
import type { PurgedInvestigation } from '../db/investigations-repository.js';
import type { PurgedPattern } from '../db/patterns-repository.js';
import { STALE_EXPORT_MS } from '../exports/limits.js';
import type { ExportFileStore } from '../exports/store.js';
import type { AuditSink } from '../seams/seams.js';
import type { Task } from './tasks.js';

/** What the purge needs of the store: the deletion of what has passed its purge date. */
export interface PurgeStore {
  purgeExpiredInvestigations(beforeDelete: (purged: PurgedInvestigation) => Promise<void>): Promise<number>;
  purgeExpiredPatterns(beforeDelete: (purged: PurgedPattern) => Promise<void>): Promise<number>;
}

export interface MaintenanceDeps {
  readonly store: PurgeStore;
  readonly exports: Pick<ExportStore, 'exportFileKeys' | 'listExpiredExports' | 'listStalePendingExports' | 'listStorageKeys' | 'expireExport' | 'failExport' | 'deleteStaleIdempotent'>;
  readonly files: ExportFileStore;
  readonly audit: AuditSink;
  readonly logger: FastifyBaseLogger;
}

const PURGE_TASK = 'purge-deleted-investigations';
/** Every day at 03:17; the minute is off the hour so copies of other products do not all start together. */
const PURGE_SCHEDULE = '17 3 * * *';
const PATTERN_PURGE_TASK = 'purge-deleted-patterns';
/** Every day at 03:29, between the other two so that no two of them compete. */
const PATTERN_PURGE_SCHEDULE = '29 3 * * *';
const EXPIRE_TASK = 'expire-exports';
/** Every day at 03:41, apart from the purge so the two do not compete for the same rows. */
const EXPIRE_SCHEDULE = '41 3 * * *';

/** Removes the investigations whose purge date has passed, and what hangs off them. It is safe to run twice and at the same moment: each investigation is taken under a lock and deleted once. */
export async function purgeDeletedInvestigations(deps: MaintenanceDeps): Promise<number> {
  const purged = await deps.store.purgeExpiredInvestigations(async ({ id, sourceId }) => {
    for (const key of await deps.exports.exportFileKeys(id)) await deps.files.remove(key);
    await deps.audit.record({ actorId: 'system', actorRole: 'system', action: 'investigation.purge', traceId: 'purge', result: 'success', sourceId });
  });
  deps.logger.info({ event: 'investigation.purged', count: purged }, 'deleted investigations purged');
  return purged;
}

/** Removes the saved patterns whose purge date has passed. One system event for each, with the source and nothing of the pattern; the count goes only in the log. The pattern's own event history stays. Safe to run twice and at the same moment. */
export async function purgeDeletedPatterns(deps: MaintenanceDeps): Promise<number> {
  const purged = await deps.store.purgeExpiredPatterns(async ({ sourceId }) => {
    await deps.audit.record({ actorId: 'system', actorRole: 'system', action: 'pattern.purge', traceId: 'purge', result: 'success', sourceId });
  });
  deps.logger.info({ event: 'pattern.purged', count: purged }, 'deleted patterns purged');
  return purged;
}

export interface ExpiredExports {
  readonly expired: number;
  readonly failed: number;
  readonly temporaryFiles: number;
  readonly unnamedFiles: number;
  readonly idempotencyKeys: number;
}

/** Deletes the files of exports past their expiry and marks them expired, fails the rows of calls that never finished, removes leftover temporary files and old idempotency keys, and counts the files no row names (it leaves those alone). Safe to run twice. */
export async function expireExports(deps: MaintenanceDeps): Promise<ExpiredExports> {
  let expired = 0;
  for (const { id, storageKey } of await deps.exports.listExpiredExports()) {
    if (storageKey !== null) await deps.files.remove(storageKey);
    await deps.exports.expireExport(id);
    expired += 1;
  }
  const stale = await deps.exports.listStalePendingExports(STALE_EXPORT_MS);
  for (const id of stale) {
    // a call killed after its file was written leaves the file under the export's ID with the row still pending
    await deps.files.remove(id);
    await deps.exports.failExport(id, 'EXPORT_FAILED');
  }
  const temporaryFiles = await deps.files.sweepTemporary(STALE_EXPORT_MS);
  const named = new Set(await deps.exports.listStorageKeys());
  const unnamedFiles = (await deps.files.list()).filter((name) => !named.has(name)).length;
  const idempotencyKeys = await deps.exports.deleteStaleIdempotent();
  const result = { expired, failed: stale.length, temporaryFiles, unnamedFiles, idempotencyKeys };
  deps.logger.info({ event: 'export.expired', ...result }, 'expired exports removed');
  return result;
}

export function maintenanceTasks(deps: MaintenanceDeps): readonly Task[] {
  return [
    { name: PURGE_TASK, schedule: PURGE_SCHEDULE, run: async () => void (await purgeDeletedInvestigations(deps)) },
    { name: PATTERN_PURGE_TASK, schedule: PATTERN_PURGE_SCHEDULE, run: async () => void (await purgeDeletedPatterns(deps)) },
    { name: EXPIRE_TASK, schedule: EXPIRE_SCHEDULE, run: async () => void (await expireExports(deps)) },
  ];
}
