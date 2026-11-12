import { Logger, runMigrations } from 'graphile-worker';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator, NO_MIGRATIONS } from 'kysely/migration';
import pg from 'pg';
import { connectionCause, isConnectionError, type ConnectionCause } from '../database-errors.js';
import { createAddressCache, lookupStream } from '../db/lookup.js';
import { appliedNames, EE_HISTORY_TABLE, EE_LOCK_TABLE, grantDefaultsOnce, grantMigrationNames, grantQueue, historyTablesExist, protectHistory, roleExists, tableExists } from './grants.js';
import { sqlFileProvider } from './provider.js';

export interface MigrateOptions {
  readonly url: string;
  readonly appRole: string;
  /** The limit on opening one connection, the name lookup included. */
  readonly connectTimeoutMs: number;
  readonly directory: string;
  /** The migrations of the enterprise code, applied after the rest and recorded in a history table of their own; absent, none are. */
  readonly eeDirectory?: string;
}

export type MigrateOutcome =
  | { readonly status: 'done'; readonly applied: readonly string[] }
  | { readonly status: 'unreachable'; readonly cause?: ConnectionCause }
  | { readonly status: 'unknown-role' }
  | { readonly status: 'migration-failed'; readonly file: string }
  | { readonly status: 'out-of-order'; readonly file: string }
  | { readonly status: 'ee-migration-failed'; readonly file: string }
  | { readonly status: 'ee-out-of-order'; readonly file: string }
  | { readonly status: 'ee-failed' }
  | { readonly status: 'queue-step-failed' }
  | { readonly status: 'failed' };

export const RUN_LOCK_ID = '5156813097145562941';

const silentLogger = new Logger(() => () => undefined);

class LostConnection extends Error {}

function isLost(error: unknown): boolean {
  return error instanceof LostConnection || isConnectionError(error);
}

export async function migrate(options: MigrateOptions): Promise<MigrateOutcome> {
  const pool = new pg.Pool({ connectionString: options.url, max: 3, connectionTimeoutMillis: options.connectTimeoutMs, stream: lookupStream(createAddressCache()) });
  let lostConnection = false;
  let cause: ConnectionCause | undefined;
  const markLost = (error?: unknown): void => {
    lostConnection = true;
    cause ??= connectionCause(error);
  };
  pool.on('error', markLost);
  pool.on('connect', (client) => client.on('error', markLost));
  const stillConnected = (): void => {
    if (lostConnection) throw new LostConnection();
  };

  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  let lock: pg.PoolClient | undefined;
  let outcome: MigrateOutcome;
  try {
    lock = await pool.connect();
    await lock.query(`SELECT pg_advisory_lock(${RUN_LOCK_ID})`);
    outcome = await runPhases(pool, db, options, stillConnected);
    stillConnected();
  } catch (error) {
    if (isLost(error)) markLost(error);
    outcome = isLost(error) ? { status: 'unreachable', ...(cause === undefined ? {} : { cause }) } : { status: 'failed' };
  } finally {
    if (lock) {
      // Cleanup must not replace the outcome: a lost connection has already ended the session lock.
      await lock.query(`SELECT pg_advisory_unlock(${RUN_LOCK_ID})`).catch(() => undefined);
      lock.release();
    }
    await db.destroy();
    if (!pool.ended) await pool.end();
  }
  return lostConnection ? { status: 'unreachable', ...(cause === undefined ? {} : { cause }) } : outcome;
}

async function runPhases(
  pool: pg.Pool,
  db: Kysely<unknown>,
  options: MigrateOptions,
  stillConnected: () => void,
): Promise<MigrateOutcome> {
  const setupMigrator = new Migrator({ db, provider: sqlFileProvider(options.directory) });

  let alreadyApplied: readonly string[] = [];
  const setup = await pool.connect();
  try {
    if (!(await roleExists(setup, options.appRole))) return { status: 'unknown-role' };
    if (!(await historyTablesExist(setup))) await setupMigrator.migrateTo(NO_MIGRATIONS);
    await protectHistory(setup, options.appRole);
    await grantDefaultsOnce(setup, options.appRole);
    alreadyApplied = await appliedNames(setup);
  } finally {
    setup.release();
  }
  stillConnected();

  const migrator = new Migrator({ db, provider: sqlFileProvider(options.directory, alreadyApplied) });
  const known = await migrator.getMigrations();
  const lastApplied = known.findLastIndex((migration) => migration.executedAt !== undefined);
  const stray = known.find((migration, index) => migration.executedAt === undefined && index < lastApplied);
  if (stray) return { status: 'out-of-order', file: stray.name };

  const { error, results } = await migrator.migrateToLatest();
  stillConnected();
  const failed = results?.find((result) => result.status === 'Error');
  if (failed) return { status: 'migration-failed', file: failed.migrationName };
  if (error) return { status: isLost(error) ? 'unreachable' : 'failed' };
  const applied = (results ?? []).filter((result) => result.status === 'Success').map((result) => result.migrationName);

  try {
    const grant = await pool.connect();
    try {
      await grantMigrationNames(grant, options.appRole);
    } finally {
      grant.release();
    }
  } catch (error) {
    return { status: isLost(error) ? 'unreachable' : 'failed' };
  }

  try {
    await runMigrations({ pgPool: pool, logger: silentLogger });
    stillConnected();
    const finish = await pool.connect();
    try {
      await grantQueue(finish, options.appRole);
    } finally {
      finish.release();
    }
  } catch (error) {
    return { status: isLost(error) ? 'unreachable' : 'queue-step-failed' };
  }
  if (options.eeDirectory === undefined) return { status: 'done', applied };

  const ee = await runEePhase(pool, db, options.eeDirectory, options.appRole, stillConnected);
  return ee.status === 'done' ? { status: 'done', applied: [...applied, ...ee.applied] } : ee;
}

async function runEePhase(pool: pg.Pool, db: Kysely<unknown>, directory: string, appRole: string, stillConnected: () => void): Promise<MigrateOutcome> {
  const tables = { migrationTableName: EE_HISTORY_TABLE, migrationLockTableName: EE_LOCK_TABLE };
  try {
    const setup = await pool.connect();
    let alreadyApplied: readonly string[];
    try {
      // migrating to nothing makes the history tables exist; it is done only when they do not, as it would undo what is applied
      if (!(await tableExists(setup, EE_HISTORY_TABLE))) await new Migrator({ db, provider: sqlFileProvider(directory), ...tables }).migrateTo(NO_MIGRATIONS);
      await protectHistory(setup, appRole, [EE_HISTORY_TABLE, EE_LOCK_TABLE]);
      alreadyApplied = await appliedNames(setup, EE_HISTORY_TABLE);
    } finally {
      setup.release();
    }
    stillConnected();

    const migrator = new Migrator({ db, provider: sqlFileProvider(directory, alreadyApplied), ...tables });
    const known = await migrator.getMigrations();
    const lastApplied = known.findLastIndex((migration) => migration.executedAt !== undefined);
    const stray = known.find((migration, index) => migration.executedAt === undefined && index < lastApplied);
    if (stray) return { status: 'ee-out-of-order', file: stray.name };

    const { error, results } = await migrator.migrateToLatest();
    stillConnected();
    const failed = results?.find((result) => result.status === 'Error');
    if (failed) return { status: 'ee-migration-failed', file: failed.migrationName };
    if (error) return { status: isLost(error) ? 'unreachable' : 'ee-failed' };
    return { status: 'done', applied: (results ?? []).filter((result) => result.status === 'Success').map((result) => result.migrationName) };
  } catch (error) {
    return { status: isLost(error) ? 'unreachable' : 'ee-failed' };
  }
}
