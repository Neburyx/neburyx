import type { AuditTransaction } from '@neburyx/contracts';
import type pg from 'pg';
import { inTransaction } from './investigations-repository.js';

type ExportKind = 'view' | 'table-csv' | 'audit-csv';
type ExportRowFormat = 'json' | 'csv' | 'png';
type ExportStatus = 'pending' | 'ready' | 'failed' | 'expired';

export interface ExportRow {
  readonly id: string;
  readonly investigationId: string | null;
  readonly requestedBy: string;
  readonly policyVersion: string;
  /** The identity of the source when the export was made; `null` for an export made before it was recorded. */
  readonly sourceIdentityHash: string | null;
  readonly kind: ExportKind;
  readonly format: ExportRowFormat;
  readonly masked: boolean;
  readonly maskedFieldCount: number;
  readonly status: ExportStatus;
  readonly filename: string | null;
  readonly storageKey: string | null;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface NewExport {
  readonly id: string;
  readonly investigationId: string;
  readonly requestedBy: string;
  readonly policyVersion: string;
  readonly sourceIdentityHash: string;
  readonly format: 'json' | 'csv';
  readonly retentionDays: number;
}

interface ReadyExport {
  readonly filename: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly masked: boolean;
  readonly maskedFieldCount: number;
}

/** An export of the requester, with what the download's re-check needs of its investigation. `expiredNow` is the database's answer, so the clock of the API process never decides it. */
export interface ExportWithInvestigation {
  readonly row: ExportRow;
  readonly expiredNow: boolean;
  readonly investigation: { readonly ownerId: string; readonly sourceId: string; readonly deleted: boolean } | undefined;
}

interface ExpiredExport {
  readonly id: string;
  readonly storageKey: string | null;
}

export type IdempotencyStart =
  | { readonly outcome: 'new' }
  | { readonly outcome: 'replay'; readonly statusCode: number; readonly response: unknown; readonly policyVersion: string }
  | { readonly outcome: 'conflict' };

interface IdempotencyKeyCall {
  readonly userId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly policyVersion: string;
}

export interface ExportStore {
  /** Inserts a `pending` row whose expiry is the database's now plus the retention days. */
  insertExport(input: NewExport): Promise<ExportRow>;
  /** Marks the export ready; `beforeCommit` runs inside the same transaction, so a throw leaves the export as it was. */
  completeExport(id: string, ready: ReadyExport, beforeCommit?: (transaction: AuditTransaction) => Promise<void>): Promise<void>;
  /** Sets the row `failed` and clears its storage key; `whileHeld` runs first with the row locked, and a row that is gone or no longer `pending` is left alone (answers `false`). */
  failExport(id: string, errorCode: string, whileHeld?: () => Promise<void>): Promise<boolean>;
  /** The requester's own export; another person's is `undefined`, as an unknown ID is. */
  readExport(id: string, requestedBy: string): Promise<ExportWithInvestigation | undefined>;
  /** Sets the row `expired` and clears its storage key; `whileHeld` runs first with the row locked, so a purge that is deleting the row waits for it, and a row that is gone or no longer `ready` or `pending` is left alone (answers `false`). */
  expireExport(id: string, whileHeld?: () => Promise<void>): Promise<boolean>;
  /** The `ready` exports whose expiry has passed by the database's clock. */
  listExpiredExports(): Promise<readonly ExpiredExport[]>;
  /** The `pending` rows older than `olderThanMs`. */
  listStalePendingExports(olderThanMs: number): Promise<readonly string[]>;
  /** Every storage key a row names, so a file no row names can be told. */
  listStorageKeys(): Promise<readonly string[]>;
  /** Records, through the transaction of a purge, the file key of each export of the investigation (the ID of each: a file can exist before its row names it), so the files are removed after the purge commits. */
  recordFileCleanup(investigationId: string, transaction: AuditTransaction): Promise<void>;
  /** The next `limit` keys of files a purge left to remove, in key order, after the key given. */
  fileCleanupKeys(after: string | undefined, limit: number): Promise<readonly string[]>;
  /** Which of these file names wait for their cleanup. */
  fileCleanupAmong(keys: readonly string[]): Promise<readonly string[]>;
  /** Forgets a key whose file is gone. */
  forgetFileCleanup(storageKey: string): Promise<void>;
  startIdempotent(call: IdempotencyKeyCall): Promise<IdempotencyStart>;
  finishIdempotent(userId: string, key: string, statusCode: number, response: unknown): Promise<void>;
  /** Forgets a key whose first call ended in a server error, so a retry runs again. */
  forgetIdempotent(userId: string, key: string): Promise<void>;
  /** Removes the keys older than 24 hours; answers how many. */
  deleteStaleIdempotent(): Promise<number>;
}

interface ExportRecord {
  readonly id: string;
  readonly investigation_id: string | null;
  readonly requested_by: string;
  readonly policy_version: string;
  readonly source_identity_hash: string | null;
  readonly kind: ExportKind;
  readonly format: ExportRowFormat;
  readonly masked: boolean;
  readonly masked_field_count: number;
  readonly status: ExportStatus;
  readonly filename: string | null;
  readonly storage_key: string | null;
  readonly size_bytes: string | null;
  readonly sha256: string | null;
  readonly error_code: string | null;
  readonly created_at: Date;
  readonly expires_at: Date;
}

const COLUMNS = `id, investigation_id, requested_by, policy_version, source_identity_hash, kind, format, masked, masked_field_count, status, filename, storage_key, size_bytes, sha256, error_code, created_at, expires_at`;

function rowOf(record: ExportRecord): ExportRow {
  return {
    id: record.id,
    investigationId: record.investigation_id,
    requestedBy: record.requested_by,
    policyVersion: record.policy_version,
    sourceIdentityHash: record.source_identity_hash,
    kind: record.kind,
    format: record.format,
    masked: record.masked,
    maskedFieldCount: record.masked_field_count,
    status: record.status,
    filename: record.filename,
    storageKey: record.storage_key,
    sizeBytes: record.size_bytes === null ? null : Number(record.size_bytes),
    sha256: record.sha256,
    errorCode: record.error_code,
    createdAt: record.created_at.toISOString(),
    expiresAt: record.expires_at.toISOString(),
  };
}

const IDEMPOTENCY_WINDOW = `interval '24 hours'`;
/** A call that has not answered by now was killed with its process, so its key is free again. */
const ABANDONED_CALL_MS = 15 * 60_000;

/** Locks one export in a state the caller names, runs the work, and applies the change, in one transaction: a purge deleting the row waits, and a row another path already took is left alone. */
async function changeHeldExport(pool: pg.Pool, id: string, states: readonly string[], change: string, parameters: readonly unknown[], whileHeld?: () => Promise<void>): Promise<boolean> {
  return inTransaction(pool, async (client) => {
    const held = await client.query(`SELECT 1 FROM exports WHERE id = $1 AND status = ANY($2::text[]) FOR UPDATE SKIP LOCKED`, [id, states]);
    if ((held.rowCount ?? 0) === 0) return false;
    await whileHeld?.();
    await client.query(change, [...parameters]);
    return true;
  });
}

export function createExportStore(pool: pg.Pool): ExportStore {
  return {
    async insertExport(input) {
      const result = await pool.query<ExportRecord>(
        `INSERT INTO exports (id, investigation_id, requested_by, policy_version, source_identity_hash, kind, format, status, expires_at)
         VALUES ($1, $2, $3, $4, $7, 'view', $5, 'pending', now() + make_interval(days => $6))
         RETURNING ${COLUMNS}`,
        [input.id, input.investigationId, input.requestedBy, input.policyVersion, input.format, input.retentionDays, input.sourceIdentityHash],
      );
      const [record] = result.rows;
      if (record === undefined) throw new Error('the export row was not written');
      return rowOf(record);
    },

    async completeExport(id, ready, beforeCommit) {
      await inTransaction(pool, async (client) => {
        await client.query(
          `UPDATE exports SET status = 'ready', filename = $2, storage_key = $3, size_bytes = $4, sha256 = $5, masked = $6, masked_field_count = $7, error_code = NULL WHERE id = $1`,
          [id, ready.filename, ready.storageKey, ready.sizeBytes, ready.sha256, ready.masked, ready.maskedFieldCount],
        );
        await beforeCommit?.(client);
      });
    },

    failExport: async (id, errorCode, whileHeld) => {
      const change = `UPDATE exports SET status = 'failed', storage_key = NULL, error_code = $2 WHERE id = $1`;
      if (whileHeld === undefined) {
        await pool.query(change, [id, errorCode]);
        return true;
      }
      return changeHeldExport(pool, id, ['pending'], change, [id, errorCode], whileHeld);
    },

    async readExport(id, requestedBy) {
      const result = await pool.query<ExportRecord & { owner_id: string | null; source_id: string | null; deleted: boolean | null; expired_now: boolean }>(
        `SELECT ${COLUMNS.split(', ').map((column) => `e.${column}`).join(', ')}, i.owner_id, i.source_id, (i.deleted_at IS NOT NULL) AS deleted, (e.expires_at <= now()) AS expired_now
         FROM exports e LEFT JOIN investigations i ON i.id = e.investigation_id
         WHERE e.id = $1 AND e.requested_by = $2`,
        [id, requestedBy],
      );
      const [record] = result.rows;
      if (record === undefined) return undefined;
      return {
        row: rowOf(record),
        expiredNow: record.expired_now,
        investigation: record.owner_id === null || record.source_id === null ? undefined : { ownerId: record.owner_id, sourceId: record.source_id, deleted: record.deleted === true },
      };
    },

    expireExport: (id, whileHeld) => changeHeldExport(pool, id, ['ready', 'pending'], `UPDATE exports SET status = 'expired', storage_key = NULL WHERE id = $1`, [id], whileHeld),

    async listExpiredExports() {
      const result = await pool.query<{ id: string; storage_key: string | null }>(`SELECT id, storage_key FROM exports WHERE status = 'ready' AND expires_at <= now() ORDER BY expires_at, id`);
      return result.rows.map((row) => ({ id: row.id, storageKey: row.storage_key }));
    },

    async listStalePendingExports(olderThanMs) {
      const result = await pool.query<{ id: string }>(`SELECT id FROM exports WHERE status = 'pending' AND created_at <= now() - make_interval(secs => $1) ORDER BY created_at, id`, [olderThanMs / 1000]);
      return result.rows.map((row) => row.id);
    },

    async listStorageKeys() {
      const result = await pool.query<{ storage_key: string }>(`SELECT storage_key FROM exports WHERE storage_key IS NOT NULL`);
      return result.rows.map((row) => row.storage_key);
    },

    async recordFileCleanup(investigationId, transaction) {
      // every row, whatever its state: a removal that failed and was passed over leaves a file behind an expired or failed row, and removing a file that is gone is nothing. The lock makes a running expiry finish first.
      await transaction.query(`INSERT INTO file_cleanup (storage_key) SELECT held.id FROM (SELECT id::text AS id FROM exports WHERE investigation_id = $1 FOR UPDATE) AS held ON CONFLICT DO NOTHING`, [investigationId]);
    },

    async fileCleanupKeys(after, limit) {
      const result = await pool.query<{ storage_key: string }>(`SELECT storage_key FROM file_cleanup WHERE ($1::text IS NULL OR storage_key > $1) ORDER BY storage_key LIMIT $2`, [after ?? null, limit]);
      return result.rows.map((row) => row.storage_key);
    },

    async fileCleanupAmong(keys) {
      if (keys.length === 0) return [];
      const result = await pool.query<{ storage_key: string }>(`SELECT storage_key FROM file_cleanup WHERE storage_key = ANY($1::text[])`, [keys]);
      return result.rows.map((row) => row.storage_key);
    },

    async forgetFileCleanup(storageKey) {
      await pool.query(`DELETE FROM file_cleanup WHERE storage_key = $1`, [storageKey]);
    },

    async startIdempotent(call) {
      return inTransaction(pool, async (client) => {
        await client.query(
          `DELETE FROM export_idempotency WHERE user_id = $1 AND key = $2 AND (created_at <= now() - ${IDEMPOTENCY_WINDOW} OR (state = 'running' AND created_at <= now() - make_interval(secs => $3)))`,
          [call.userId, call.key, ABANDONED_CALL_MS / 1000],
        );
        const inserted = await client.query(
          `INSERT INTO export_idempotency (user_id, key, fingerprint, policy_version) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, key) DO NOTHING RETURNING key`,
          [call.userId, call.key, call.fingerprint, call.policyVersion],
        );
        if (inserted.rowCount === 1) return { outcome: 'new' } as const;
        const found = await client.query<{ fingerprint: string; policy_version: string; state: 'running' | 'done'; status_code: number | null; response: unknown }>(
          `SELECT fingerprint, policy_version, state, status_code, response FROM export_idempotency WHERE user_id = $1 AND key = $2`,
          [call.userId, call.key],
        );
        const [held] = found.rows;
        if (held === undefined || held.fingerprint !== call.fingerprint || held.state === 'running' || held.status_code === null) return { outcome: 'conflict' } as const;
        return { outcome: 'replay', statusCode: held.status_code, response: held.response, policyVersion: held.policy_version } as const;
      });
    },

    async finishIdempotent(userId, key, statusCode, response) {
      await pool.query(`UPDATE export_idempotency SET state = 'done', status_code = $3, response = $4::jsonb WHERE user_id = $1 AND key = $2`, [userId, key, statusCode, JSON.stringify(response)]);
    },

    async forgetIdempotent(userId, key) {
      await pool.query(`DELETE FROM export_idempotency WHERE user_id = $1 AND key = $2`, [userId, key]);
    },

    async deleteStaleIdempotent() {
      const result = await pool.query(`DELETE FROM export_idempotency WHERE created_at <= now() - ${IDEMPOTENCY_WINDOW}`);
      return result.rowCount ?? 0;
    },
  };
}
