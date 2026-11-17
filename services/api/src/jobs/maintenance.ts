import type { AuditTransaction } from '@neburyx/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { ExportStore } from '../db/exports-repository.js';
import type { PurgedInvestigation } from '../db/investigations-repository.js';
import type { PurgedPattern } from '../db/patterns-repository.js';
import { STALE_EXPORT_MS } from '../exports/limits.js';
import type { ExportFileStore } from '../exports/store.js';
import type { AuditSink } from '../seams/seams.js';
import type { Task } from './tasks.js';

/** What the purge needs of the store: the deletion of what has passed its purge date. */
interface PurgeStore {
  purgeExpiredInvestigations(beforeDelete: (purged: PurgedInvestigation, transaction: AuditTransaction) => Promise<void>): Promise<number>;
  purgeExpiredPatterns(beforeDelete: (purged: PurgedPattern, transaction: AuditTransaction) => Promise<void>): Promise<number>;
}

export interface MaintenanceDeps {
  readonly store: PurgeStore;
  readonly exports: Pick<ExportStore, 'recordFileCleanup' | 'fileCleanupKeys' | 'fileCleanupAmong' | 'forgetFileCleanup' | 'listExpiredExports' | 'listStalePendingExports' | 'listStorageKeys' | 'expireExport' | 'failExport' | 'deleteStaleIdempotent'>;
  readonly files: ExportFileStore;
  readonly audit: AuditSink;
  readonly logger: FastifyBaseLogger;
}

const PURGE_TASK = 'purge-deleted-investigations';
/** Every day at 03:17; the minute is off the hour so copies of other products do not all start together. */
const PURGE_SCHEDULE = '17 3 * * *';
/** How many cleanup records one read takes; the backlog is worked through in batches of this size. */
const CLEANUP_BATCH = 100;
const CLEANUP_TASK = 'remove-purged-files';
/** Every ten minutes, so files a crash between a purge's commit and the removal left behind go soon, not at the next purge. */
const CLEANUP_SCHEDULE = '*/10 * * * *';
const PATTERN_PURGE_TASK = 'purge-deleted-patterns';
/** Every day at 03:29, between the other two so that no two of them compete. */
const PATTERN_PURGE_SCHEDULE = '29 3 * * *';
const EXPIRE_TASK = 'expire-exports';
/** Every day at 03:41, apart from the purge so the two do not compete for the same rows. */
const EXPIRE_SCHEDULE = '41 3 * * *';

/** Removes the investigations whose purge date has passed, and what hangs off them. It is safe to run twice and at the same moment: each investigation is taken under a lock and deleted once. The event and the keys of the export files are written in the transaction that deletes the investigation, so nothing is removed for a purge that does not happen; the files go afterwards (`removePurgedFiles`). */
export async function purgeDeletedInvestigations(deps: MaintenanceDeps): Promise<number> {
  const purged = await deps.store.purgeExpiredInvestigations(async ({ id, sourceId }, transaction) => {
    await deps.audit.record({ actorId: 'system', actorRole: 'system', action: 'investigation.purge', traceId: 'purge', result: 'success', sourceId }, { transaction });
    await deps.exports.recordFileCleanup(id, transaction);
  });
  deps.logger.info({ event: 'investigation.purged', count: purged }, 'deleted investigations purged');
  return purged;
}

/** Removes the saved patterns whose purge date has passed. One system event for each, with the source and nothing of the pattern; the count goes only in the log. The pattern's own event history stays. Safe to run twice and at the same moment. */
export async function purgeDeletedPatterns(deps: MaintenanceDeps): Promise<number> {
  const purged = await deps.store.purgeExpiredPatterns(async ({ sourceId }, transaction) => {
    await deps.audit.record({ actorId: 'system', actorRole: 'system', action: 'pattern.purge', traceId: 'purge', result: 'success', sourceId }, { transaction });
  });
  deps.logger.info({ event: 'pattern.purged', count: purged }, 'deleted patterns purged');
  return purged;
}

/** Removes the files a purge left to remove, each key only when its file is gone: a file already missing counts as gone, a second run changes nothing, and a file that cannot be removed keeps its key and fails the run so the runner tries again after the others are done. */
export async function removePurgedFiles(deps: MaintenanceDeps): Promise<number> {
  let removed = 0;
  let failure: unknown;
  let after: string | undefined;
  for (;;) {
    const keys = await deps.exports.fileCleanupKeys(after, CLEANUP_BATCH);
    for (const key of keys) {
      try {
        await deps.files.remove(key);
        await deps.exports.forgetFileCleanup(key);
        removed += 1;
      } catch (error) {
        failure ??= error;
      }
    }
    // the next batch starts after this one's last key, so a key that cannot be removed does not hold the others back
    after = keys.at(-1);
    if (keys.length < CLEANUP_BATCH) break;
  }
  deps.logger.info({ event: 'export.purged_files_removed', count: removed }, 'files of purged investigations removed');
  if (failure !== undefined) throw failure;
  return removed;
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
    // the row is locked while its file goes, and a row a purge already took, or deleted since the list was read, is left to the purge's cleanup
    const taken = await deps.exports.expireExport(id, async () => {
      if (storageKey !== null) await deps.files.remove(storageKey);
    });
    if (taken) expired += 1;
  }
  const stale = await deps.exports.listStalePendingExports(STALE_EXPORT_MS);
  let failed = 0;
  for (const id of stale) {
    // a call killed after its file was written leaves the file under the export's ID with the row still pending
    if (await deps.exports.failExport(id, 'EXPORT_FAILED', () => deps.files.remove(id))) failed += 1;
  }
  const temporaryFiles = await deps.files.sweepTemporary(STALE_EXPORT_MS);
  const named = new Set(await deps.exports.listStorageKeys());
  const unnamed = (await deps.files.list()).filter((name) => !named.has(name));
  const waiting = new Set(await deps.exports.fileCleanupAmong(unnamed));
  const unnamedFiles = unnamed.filter((name) => !waiting.has(name)).length;
  const idempotencyKeys = await deps.exports.deleteStaleIdempotent();
  const result = { expired, failed, temporaryFiles, unnamedFiles, idempotencyKeys };
  deps.logger.info({ event: 'export.expired', ...result }, 'expired exports removed');
  return result;
}

export function maintenanceTasks(deps: MaintenanceDeps): readonly Task[] {
  return [
    {
      name: PURGE_TASK,
      schedule: PURGE_SCHEDULE,
      run: async () => {
        await purgeDeletedInvestigations(deps);
        await removePurgedFiles(deps);
      },
    },
    { name: CLEANUP_TASK, schedule: CLEANUP_SCHEDULE, run: async () => void (await removePurgedFiles(deps)) },
    { name: PATTERN_PURGE_TASK, schedule: PATTERN_PURGE_SCHEDULE, run: async () => void (await purgeDeletedPatterns(deps)) },
    { name: EXPIRE_TASK, schedule: EXPIRE_SCHEDULE, run: async () => void (await expireExports(deps)) },
  ];
}
