import type pg from 'pg';
import type { Identity } from '../identity/identity.js';
import { uuidv7 } from '../identity/uuid.js';

const LOCAL = 'local';
const LOCAL_DISPLAY_NAME = 'Local workspace';

interface IdentityRow {
  readonly id: string;
  readonly display_name: string;
  readonly role: Identity['principal']['role'];
  readonly edition: Identity['edition'];
  readonly identity_mode: Identity['identityMode'];
}

export async function readIdentity(db: pg.Pool | pg.PoolClient): Promise<Identity> {
  const result = await db.query<IdentityRow>(
    `SELECT u.id, u.display_name, u.role, d.edition, d.identity_mode
     FROM deployment d CROSS JOIN users u WHERE u.issuer = $1 AND u.subject = $1`,
    [LOCAL],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the deployment row or the local user is missing');
  return {
    principal: { id: row.id, displayName: row.display_name, role: row.role },
    edition: row.edition,
    identityMode: row.identity_mode,
  };
}

export async function seedFirstStart(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO deployment (edition, identity_mode) VALUES ('community', 'none') ON CONFLICT DO NOTHING`);
    await client.query(
      `INSERT INTO users (id, issuer, subject, display_name, role, status) VALUES ($1, $2, $2, $3, 'administrator', 'active')
       ON CONFLICT (issuer, subject) DO NOTHING`,
      [uuidv7(), LOCAL, LOCAL_DISPLAY_NAME],
    );
    await readIdentity(client);
    await client.query('COMMIT');
  } catch (error) {
    // A failed rollback must not hide the error that caused it; the connection is released either way.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
