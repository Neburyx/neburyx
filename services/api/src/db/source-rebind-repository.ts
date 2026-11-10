import type pg from 'pg';

export type RebindOutcome =
  | { readonly outcome: 'rebound'; readonly count: number }
  | { readonly outcome: 'unknown-source' }
  | { readonly outcome: 'not-synced' }
  | { readonly outcome: 'not-tested' };

/**
 * Sets the stored identity hash of every investigation of the source whose hash differs from `identityHash`. In one transaction under a lock on the source's row it first proves that the
 * source is active, that the row holds this identity hash (the API has synced the connection) and that a stored check reached the source on this connection; it writes nothing otherwise.
 * It reads Postgres only and writes nothing but `source_identity_hash`.
 */
export async function rebindSource(db: pg.Pool, sourceId: string, identityHash: string): Promise<RebindOutcome> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<{ identity_hash: string }>('SELECT identity_hash FROM sources WHERE id = $1 AND removed_at IS NULL FOR UPDATE', [sourceId]);
    const row = locked.rows[0];
    if (row === undefined) {
      await client.query('ROLLBACK');
      return { outcome: 'unknown-source' };
    }
    if (row.identity_hash !== identityHash) {
      await client.query('ROLLBACK');
      return { outcome: 'not-synced' };
    }
    const tested = await client.query(
      `SELECT 1 FROM source_checks WHERE source_id = $1 AND identity_hash = $2 AND jsonb_typeof(report -> 'server') = 'object' LIMIT 1`,
      [sourceId, identityHash],
    );
    if ((tested.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return { outcome: 'not-tested' };
    }
    const updated = await client.query('UPDATE investigations SET source_identity_hash = $2 WHERE source_id = $1 AND source_identity_hash <> $2', [sourceId, identityHash]);
    await client.query('COMMIT');
    return { outcome: 'rebound', count: updated.rowCount ?? 0 };
  } catch (error) {
    // A failed rollback must not hide the error that caused it; the connection is released either way.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
