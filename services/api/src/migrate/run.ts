import { Logger, runMigrations } from 'graphile-worker';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator, NO_MIGRATIONS } from 'kysely/migration';
import pg from 'pg';
import { isConnectionError } from '../database-errors.js';
import { grantDefaultsOnce, grantMigrationNames, grantQueue, historyTablesExist, protectHistory, roleExists } from './grants.js';
import { sqlFileProvider } from './provider.js';

export interface MigrateOptions {
  readonly url: string;
  readonly appRole: string;
  readonly directory: string;
}

export type MigrateOutcome =
  | { readonly status: 'done'; readonly applied: readonly string[] }
  | { readonly status: 'unreachable' }
  | { readonly status: 'unknown-role' }
  | { readonly status: 'migration-failed'; readonly file: string }
  | { readonly status: 'out-of-order'; readonly file: string }
  | { readonly status: 'queue-step-failed' }
  | { readonly status: 'failed' };

export const RUN_LOCK_ID = '5156813097145562941';

const silentLogger = new Logger(() => () => undefined);

class LostConnection extends Error {}

function isLost(error: unknown): boolean {
  return error instanceof LostConnection || isConnectionError(error);
}

export async function migrate(options: MigrateOptions): Promise<MigrateOutcome> {
  const pool = new pg.Pool({ connectionString: options.url, max: 3 });
  let lostConnection = false;
  const markLost = (): void => {
    lostConnection = true;
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
    outcome = { status: isLost(error) ? 'unreachable' : 'failed' };
  } finally {
    if (lock) {
      // Cleanup must not replace the outcome: a lost connection has already ended the session lock.
      await lock.query(`SELECT pg_advisory_unlock(${RUN_LOCK_ID})`).catch(() => undefined);
      lock.release();
    }
    await db.destroy();
    if (!pool.ended) await pool.end();
  }
  return lostConnection ? { status: 'unreachable' } : outcome;
}

async function runPhases(
  pool: pg.Pool,
  db: Kysely<unknown>,
  options: MigrateOptions,
  stillConnected: () => void,
): Promise<MigrateOutcome> {
  const migrator = new Migrator({ db, provider: sqlFileProvider(options.directory) });

  const setup = await pool.connect();
  try {
    if (!(await roleExists(setup, options.appRole))) return { status: 'unknown-role' };
    if (!(await historyTablesExist(setup))) await migrator.migrateTo(NO_MIGRATIONS);
    await protectHistory(setup, options.appRole);
    await grantDefaultsOnce(setup, options.appRole);
  } finally {
    setup.release();
  }
  stillConnected();

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
  return { status: 'done', applied };
}
