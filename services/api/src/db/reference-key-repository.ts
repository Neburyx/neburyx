import { randomBytes } from 'node:crypto';
import type pg from 'pg';

export const REFERENCE_KEY_BYTES = 32;

/**
 * The deployment's reference key. The first copy to ask makes 32 random bytes and stores them with a write that only succeeds while the column is empty, so copies that start at once all end
 * with the stored key: a copy that lost the race reads the winner's.
 */
export async function referenceKeyOf(db: pg.Pool): Promise<Buffer> {
  await db.query('UPDATE deployment SET reference_key = $1 WHERE reference_key IS NULL', [randomBytes(REFERENCE_KEY_BYTES)]);
  const result = await db.query<{ reference_key: Buffer | null }>('SELECT reference_key FROM deployment');
  const key = result.rows[0]?.reference_key;
  if (key === null || key === undefined || key.length !== REFERENCE_KEY_BYTES) throw new Error('the deployment has no reference key');
  return key;
}
