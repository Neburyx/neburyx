import type { SourceState } from '@neburyx/contracts';
import type pg from 'pg';
import type { SourceModel } from '../mapping/model.js';
import { identityHashOf, SOURCE_CONNECTOR } from '../registry/identity-hash.js';

export const SYNC_LOCK_KEY = 4_810_212_001;

export interface SourceRow {
  readonly id: string;
  readonly alias: string;
  readonly state: SourceState;
  readonly stateReason: string | null;
  readonly synthetic: boolean;
}

interface ListedRow {
  readonly id: string;
  readonly alias: string;
  readonly state: SourceState;
  readonly state_reason: string | null;
  readonly synthetic: boolean;
}

export function secretRefOf(source: SourceModel): string {
  return `${source.auth.usernameEnv}:${source.auth.passwordEnv}`;
}

/** Writes the mapping's sources into `sources` in one transaction and returns the IDs whose connection changed. */
export async function syncSources(pool: pg.Pool, sources: readonly SourceModel[]): Promise<readonly string[]> {
  const client = await pool.connect();
  const ids = sources.map((source) => source.id);
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SYNC_LOCK_KEY]);
    const existing = await client.query<{ id: string; identity_hash: string }>('SELECT id, identity_hash FROM sources WHERE id = ANY($1::text[])', [ids]);
    const previous = new Map(existing.rows.map((row) => [row.id, row.identity_hash]));
    const changed: string[] = [];
    for (const source of sources) {
      const identityHash = identityHashOf(source);
      const before = previous.get(source.id);
      if (before !== undefined && before !== identityHash) changed.push(source.id);
      await client.query(
        `INSERT INTO sources (id, alias, connector, uri, database, secret_ref, synthetic, config_hash, identity_hash)
         VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           uri = EXCLUDED.uri,
           database = EXCLUDED.database,
           secret_ref = EXCLUDED.secret_ref,
           synthetic = EXCLUDED.synthetic,
           config_hash = EXCLUDED.config_hash,
           identity_hash = EXCLUDED.identity_hash,
           state = CASE WHEN sources.identity_hash <> EXCLUDED.identity_hash THEN 'unknown' ELSE sources.state END,
           state_reason = CASE WHEN sources.identity_hash <> EXCLUDED.identity_hash THEN NULL ELSE sources.state_reason END,
           removed_at = NULL,
           updated_at = CASE
             WHEN (sources.uri, sources.database, sources.secret_ref, sources.synthetic, sources.config_hash, sources.identity_hash, sources.removed_at IS NULL)
               IS DISTINCT FROM (EXCLUDED.uri, EXCLUDED.database, EXCLUDED.secret_ref, EXCLUDED.synthetic, EXCLUDED.config_hash, EXCLUDED.identity_hash, true)
             THEN now() ELSE sources.updated_at END`,
        [source.id, SOURCE_CONNECTOR, source.uri, source.database, secretRefOf(source), source.synthetic, source.configHash, identityHash],
      );
    }
    await client.query('UPDATE sources SET removed_at = now(), updated_at = now() WHERE removed_at IS NULL AND NOT (id = ANY($1::text[]))', [ids]);
    await client.query('COMMIT');
    return changed;
  } catch (error) {
    // A failed rollback must not hide the error that caused it; the connection is released either way.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listSourceRows(db: pg.Pool): Promise<readonly SourceRow[]> {
  const result = await db.query<ListedRow>('SELECT id, alias, state, state_reason, synthetic FROM sources WHERE removed_at IS NULL ORDER BY id COLLATE "C"');
  return result.rows.map((row) => ({ id: row.id, alias: row.alias, state: row.state, stateReason: row.state_reason, synthetic: row.synthetic }));
}
