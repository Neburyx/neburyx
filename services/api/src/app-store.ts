import type { ReadyChecks } from '@neburyx/contracts';
import { createPool } from './db/pool.js';
import { checkMigrations, pingDatabase } from './db/readiness-repository.js';
import { migrationFileNames } from './migrate/provider.js';
import { PROBE_STEP_MS, READINESS_LIMIT_MS, runReadiness } from './health/readiness.js';
import { readIdentity, seedFirstStart } from './db/identity-repository.js';
import { toStartError } from './identity/errors.js';
import type { Identity } from './identity/identity.js';

export interface AppStore {
  initialize(): Promise<void>;
  current(): Promise<Identity>;
  readiness(): Promise<ReadyChecks>;
  close(): Promise<void>;
}

export interface AppStoreOptions {
  readonly migrationsDirectory: string;
  readonly connectionTimeoutMs?: number;
}

export function createAppStore(url: string, onConnectionError: () => void, options: AppStoreOptions): AppStore {
  const pool = createPool(url, onConnectionError, options.connectionTimeoutMs === undefined ? {} : { connectionTimeoutMs: options.connectionTimeoutMs });
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
    readiness: () => runReadiness({ ping: () => pingDatabase(probes), migrations: shippedMigrations }, READINESS_LIMIT_MS),
    async close(): Promise<void> {
      await Promise.all([pool.end(), probes.end()]);
    },
  };
}
