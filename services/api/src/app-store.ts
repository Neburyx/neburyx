import type { ReadyChecks } from '@neburyx/contracts';
import { createPool } from './db/pool.js';
import { checkMigrations, pingDatabase } from './db/readiness-repository.js';
import { migrationFileNames } from './migrate/provider.js';
import { PROBE_STEP_MS, READINESS_LIMIT_MS, runReadiness } from './health/readiness.js';
import { readIdentity, seedFirstStart } from './db/identity-repository.js';
import { hasActiveSource, recordSourceCheck, type SourceCheck } from './db/source-checks-repository.js';
import { listSourceRows, syncSources, type SourceRow } from './db/sources-repository.js';
import type { SourceModel } from './mapping/model.js';
import { toStartError } from './identity/errors.js';
import type { Identity } from './identity/identity.js';

export interface AppStore {
  initialize(): Promise<void>;
  current(): Promise<Identity>;
  syncSources(sources: readonly SourceModel[]): Promise<readonly string[]>;
  listSources(): Promise<readonly SourceRow[]>;
  hasActiveSource(sourceId: string): Promise<boolean>;
  recordSourceCheck(check: SourceCheck): Promise<void>;
  readiness(): Promise<ReadyChecks>;
  close(): Promise<void>;
}

export const STORE_STATEMENT_TIMEOUT_MS = 10_000;
export const STORE_QUERY_TIMEOUT_MS = 15_000;

export interface AppStoreOptions {
  readonly migrationsDirectory: string;
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
    return shipped === undefined ? 'unknown' : checkMigrations(probes, shipped);
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
    readiness: () => runReadiness({ ping: () => pingDatabase(probes), migrations: shippedMigrations }, READINESS_LIMIT_MS),
    async close(): Promise<void> {
      await Promise.all([pool.end(), probes.end()]);
    },
  };
}
