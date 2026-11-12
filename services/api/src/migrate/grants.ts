import type pg from 'pg';

const HISTORY_TABLES = ['kysely_migration', 'kysely_migration_lock'];
export const EE_HISTORY_TABLE = 'kysely_migration_ee';
export const EE_LOCK_TABLE = 'kysely_migration_lock_ee';
const SETUP_TABLE = 'neburyx_setup';
const POLICY_NAME = 'neburyx_app_access';
const QUEUE_SCHEMA = 'graphile_worker';
const QUEUE_HISTORY_TABLE = 'migrations';

async function inTransaction(client: pg.PoolClient, work: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function roleExists(client: pg.PoolClient, role: string): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  return result.rowCount === 1;
}

export async function historyTablesExist(client: pg.PoolClient): Promise<boolean> {
  const result = await client.query(`SELECT to_regclass('public.kysely_migration') IS NOT NULL AS found`);
  return result.rows[0]?.found === true;
}

export async function tableExists(client: pg.PoolClient, table: string): Promise<boolean> {
  const result = await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`public.${client.escapeIdentifier(table)}`]);
  return result.rows[0]?.found === true;
}

export async function protectHistory(client: pg.PoolClient, role: string, historyTables: readonly string[] = HISTORY_TABLES): Promise<void> {
  const tables = historyTables.map((table) => client.escapeIdentifier(table)).join(', ');
  await client.query(`REVOKE ALL ON TABLE ${tables} FROM ${client.escapeIdentifier(role)}`);
}

export async function grantDefaultsOnce(client: pg.PoolClient, role: string): Promise<void> {
  const app = client.escapeIdentifier(role);
  await inTransaction(client, async () => {
    await client.query(`CREATE TABLE IF NOT EXISTS ${SETUP_TABLE} (app_role text PRIMARY KEY)`);
    await client.query(`REVOKE ALL ON TABLE ${SETUP_TABLE} FROM ${app}`);
    const first = await client.query(`INSERT INTO ${SETUP_TABLE} (app_role) VALUES ($1) ON CONFLICT DO NOTHING`, [role]);
    if (first.rowCount === 0) return;
    await client.query(`GRANT USAGE ON SCHEMA public TO ${app}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${app}`);
  });
}

async function policyIsCurrent(client: pg.PoolClient, table: string, role: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM pg_policies
     WHERE schemaname = $1 AND tablename = $2 AND policyname = $3
       AND roles = ARRAY[$4]::name[] AND cmd = 'ALL' AND qual = 'true' AND with_check = 'true'`,
    [QUEUE_SCHEMA, table, POLICY_NAME, role],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function grantMigrationNames(client: pg.PoolClient, role: string): Promise<void> {
  const found = await client.query(`SELECT to_regprocedure('public.applied_migrations()') IS NOT NULL AS found`);
  if (found.rows[0]?.found !== true) return;
  await client.query(`GRANT EXECUTE ON FUNCTION public.applied_migrations() TO ${client.escapeIdentifier(role)}`);
  const preview = await client.query(`SELECT to_regprocedure('public.applied_preview_migrations()') IS NOT NULL AS found`);
  if (preview.rows[0]?.found !== true) return;
  await client.query(`GRANT EXECUTE ON FUNCTION public.applied_preview_migrations() TO ${client.escapeIdentifier(role)}`);
}

export async function grantQueue(client: pg.PoolClient, role: string): Promise<void> {
  const app = client.escapeIdentifier(role);
  await inTransaction(client, async () => {
    await client.query(`GRANT USAGE ON SCHEMA ${QUEUE_SCHEMA} TO ${app}`);

    const tables = await client.query<{ name: string; guarded: boolean }>(
      `SELECT c.relname AS name, c.relrowsecurity AS guarded FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
      [QUEUE_SCHEMA],
    );
    for (const { name, guarded } of tables.rows) {
      const qualified = `${QUEUE_SCHEMA}.${client.escapeIdentifier(name)}`;
      if (name === QUEUE_HISTORY_TABLE) {
        await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE ${qualified} FROM ${app}`);
        await client.query(`GRANT SELECT ON TABLE ${qualified} TO ${app}`);
        continue;
      }
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${qualified} TO ${app}`);
      if (guarded && !(await policyIsCurrent(client, name, role))) {
        await client.query(`DROP POLICY IF EXISTS ${POLICY_NAME} ON ${qualified}`);
        await client.query(`CREATE POLICY ${POLICY_NAME} ON ${qualified} FOR ALL TO ${app} USING (true) WITH CHECK (true)`);
      }
    }

    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${QUEUE_SCHEMA} TO ${app}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${QUEUE_SCHEMA} TO ${app}`);
  });
}

/** The names the history table holds, read under the run's lock. The history tables must exist. */
export async function appliedNames(client: pg.PoolClient, table = 'kysely_migration'): Promise<readonly string[]> {
  const result = await client.query<{ name: string }>(`SELECT name FROM ${client.escapeIdentifier(table)}`);
  return result.rows.map((row) => row.name);
}
