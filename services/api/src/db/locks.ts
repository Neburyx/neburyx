import type pg from 'pg';

/** Locks the owner's live investigation row. Every writer that takes more than one row of an investigation takes this one first, then the draft, then a view, so two writers never wait for each other's rows. Answers whether the row was found. */
export async function lockLiveInvestigation(client: pg.PoolClient, investigationId: string, ownerId: string): Promise<boolean> {
  const found = await client.query(`SELECT 1 FROM investigations WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR UPDATE`, [investigationId, ownerId]);
  return found.rowCount !== 0;
}
