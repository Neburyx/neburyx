import type { ReadyChecks } from '@neburyx/contracts';
import { createPool } from './db/pool.js';
import { checkMigrations, pingDatabase } from './db/readiness-repository.js';
import { migrationFileNames } from './migrate/provider.js';
import { PROBE_STEP_MS, READINESS_LIMIT_MS, runReadiness } from './health/readiness.js';
import { readIdentity, seedFirstStart } from './db/identity-repository.js';
import { createExportStore, type ExportStore } from './db/exports-repository.js';
import { changeInvestigationStatus, createInvestigation, deleteInvestigation, purgeExpiredInvestigations, restoreInvestigation, findReusableInvestigation, readInvestigation, readLibrary, renameInvestigation, saveDraft, type InvestigationStore } from './db/investigations-repository.js';
import { listOwnedViews, type OwnedViewStore } from './db/views-list-repository.js';
import { deleteNamedView, listNamedViews, renameNamedView, restoreNamedView, saveNamedView, type ViewStore } from './db/views-repository.js';
import { referenceKeyOf } from './db/reference-key-repository.js';
import type { SourceHashes } from './source-state/decide.js';
import { applyPingState, hasActiveSource, latestChecksFor, latestQualifyingChecks, markSourceUnchecked, recordSourceCheck, type CheckedSource, type PingStateChange, type QualifyingCheck, type SourceCheck } from './db/source-checks-repository.js';
import { listSourceRows, syncSources, type SourceRow } from './db/sources-repository.js';
import { rebindSource, type RebindOutcome } from './db/source-rebind-repository.js';
import type { SourceModel } from './mapping/model.js';
import { toStartError } from './identity/errors.js';
import type { Identity } from './identity/identity.js';

export interface AppStore extends InvestigationStore, ViewStore, OwnedViewStore, ExportStore {
  initialize(): Promise<void>;
  current(): Promise<Identity>;
  syncSources(sources: readonly SourceModel[]): Promise<readonly string[]>;
  listSources(): Promise<readonly SourceRow[]>;
  hasActiveSource(sourceId: string): Promise<boolean>;
  recordSourceCheck(check: SourceCheck): Promise<void>;
  markSourceUnchecked(sourceId: string, reason: string, source: SourceHashes): Promise<void>;
  latestQualifyingChecks(sources: readonly CheckedSource[], since: string, onUnreadable?: (sourceId: string, checkedAt: string) => void): Promise<QualifyingCheck[]>;
  latestChecksFor(sources: readonly CheckedSource[], onUnreadable?: (sourceId: string, checkedAt: string) => void): Promise<QualifyingCheck[]>;
  applyPingState(change: PingStateChange): Promise<boolean>;
  /** Confirms a source that was re-pointed on purpose: its investigations take the identity hash it has now (`neburyx source rebind`). */
  rebindSource(sourceId: string, identityHash: string): Promise<RebindOutcome>;
  readiness(): Promise<ReadyChecks>;
  /** The deployment's reference key, made by the first copy that asks and the same for every copy. */
  referenceKey(): Promise<Buffer>;
  close(): Promise<void>;
}

export const STORE_STATEMENT_TIMEOUT_MS = 10_000;
export const STORE_QUERY_TIMEOUT_MS = 15_000;

export interface AppStoreOptions {
  readonly migrationsDirectory: string;
  /** The migrations of the preview, which count for readiness only when the preview is on. */
  readonly previewMigrationsDirectory?: string;
  readonly connectionTimeoutMs?: number;
}

export function createAppStore(url: string, onConnectionError: () => void, options: AppStoreOptions): AppStore {
  const pool = createPool(url, onConnectionError, {
    statementTimeoutMs: STORE_STATEMENT_TIMEOUT_MS,
    queryTimeoutMs: STORE_QUERY_TIMEOUT_MS,
    ...(options.connectionTimeoutMs === undefined ? {} : { connectionTimeoutMs: options.connectionTimeoutMs }),
  });
  const probes = createPool(url, onConnectionError, { max: 2, connectionTimeoutMs: PROBE_STEP_MS, statementTimeoutMs: PROBE_STEP_MS, queryTimeoutMs: PROBE_STEP_MS });

  async function shippedMigrations(): Promise<ReadyChecks['migrations']> {
    const shipped = await migrationFileNames(options.migrationsDirectory).catch(() => undefined);
    if (shipped === undefined) return 'unknown';
    if (options.previewMigrationsDirectory === undefined) return checkMigrations(probes, shipped);
    const shippedPreview = await migrationFileNames(options.previewMigrationsDirectory).catch(() => undefined);
    return shippedPreview === undefined ? 'unknown' : checkMigrations(probes, shipped, shippedPreview);
  }

  return {
    async initialize(): Promise<void> {
      try {
        await seedFirstStart(pool);
      } catch (error) {
        throw toStartError(error);
      }
    },
    current: () => readIdentity(pool),
    syncSources: (sources) => syncSources(pool, sources),
    listSources: () => listSourceRows(pool),
    hasActiveSource: (sourceId) => hasActiveSource(pool, sourceId),
    recordSourceCheck: (check) => recordSourceCheck(pool, check),
    markSourceUnchecked: (sourceId, reason, source) => markSourceUnchecked(pool, sourceId, reason, source),
    latestQualifyingChecks: (sources, since, onUnreadable) => latestQualifyingChecks(pool, sources, since, onUnreadable),
    latestChecksFor: (sources, onUnreadable) => latestChecksFor(pool, sources, onUnreadable),
    referenceKey: () => referenceKeyOf(pool),
    applyPingState: (change) => applyPingState(pool, change),
    rebindSource: (sourceId, identityHash) => rebindSource(pool, sourceId, identityHash),
    createInvestigation: (input) => createInvestigation(pool, input),
    findReusableInvestigation: (query) => findReusableInvestigation(pool, query),
    ...createExportStore(pool),
    readInvestigation: (id, ownerId) => readInvestigation(pool, id, ownerId),
    saveDraft: (write) => saveDraft(pool, write),
    renameInvestigation: (change) => renameInvestigation(pool, change),
    changeInvestigationStatus: (change) => changeInvestigationStatus(pool, change),
    saveNamedView: (save) => saveNamedView(pool, save),
    listNamedViews: (query) => listNamedViews(pool, query),
    listOwnedViews: (query) => listOwnedViews(pool, query),
    renameNamedView: (rename) => renameNamedView(pool, rename),
    deleteNamedView: (deletion) => deleteNamedView(pool, deletion),
    purgeExpiredInvestigations: (beforeDelete) => purgeExpiredInvestigations(pool, beforeDelete),
    deleteInvestigation: (change) => deleteInvestigation(pool, change),
    restoreInvestigation: (change) => restoreInvestigation(pool, change),
    restoreNamedView: (restore) => restoreNamedView(pool, restore),
    readLibrary: (read) => readLibrary(pool, read),
    readiness: () => runReadiness({ ping: () => pingDatabase(probes), migrations: shippedMigrations }, READINESS_LIMIT_MS),
    async close(): Promise<void> {
      await Promise.all([pool.end(), probes.end()]);
    },
  };
}
