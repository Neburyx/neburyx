import { serverVersionText } from '../source-test/server-version.js';
import { sourceTestReportSchema, type SourceTestReport } from '@neburyx/contracts';
import { readStoredReport } from '../source-test/stored-report.js';
import { NOT_CHECKED_SINCE_START } from '../source-test/reasons.js';
import type pg from 'pg';
import { AppError } from '../errors.js';

export const KEPT_CHECKS = 50;

export interface SourceCheck {
  readonly id: string;
  readonly report: SourceTestReport;
  readonly triggeredBy: string | null;
  /** The identity hash of the connection that was tested, not of the row the run is stored beside. */
  readonly identityHash: string;
  /** The hash of the whole source entry of the mapping that was tested, so that a check of another mapping never counts for this one. */
  readonly configHash: string;
}

/** The text kept in `server_version`: `Neo4j <version>` for the Neo4j kernel and `<product> <version>` for any other product. */
export function serverVersionOf(report: SourceTestReport): string | null {
  return report.server === null ? null : serverVersionText(report.server);
}

export async function hasActiveSource(db: pg.Pool, sourceId: string): Promise<boolean> {
  const result = await db.query('SELECT 1 FROM sources WHERE id = $1 AND removed_at IS NULL', [sourceId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Stores one run, keeps the newest `KEPT_CHECKS` rows of that source and sets the source's state from its newest row,
 * in one transaction under a lock on the source row, so concurrent runs end with the state of the newest row.
 */
export async function recordSourceCheck(db: pg.Pool, check: SourceCheck): Promise<void> {
  const report = sourceTestReportSchema.parse(check.report);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT 1 FROM sources WHERE id = $1 AND removed_at IS NULL FOR UPDATE', [report.sourceId]);
    if ((locked.rowCount ?? 0) === 0) throw new AppError('NOT_FOUND');
    await client.query(
      `INSERT INTO source_checks (id, source_id, checked_at, triggered_by, outcome, server_version, read_only_check, report, identity_hash, config_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [check.id, report.sourceId, report.checkedAt, check.triggeredBy, report.outcome, serverVersionOf(report), report.readOnlyCheck, JSON.stringify(report), check.identityHash, check.configHash],
    );
    await client.query(
      `DELETE FROM source_checks WHERE source_id = $1 AND id NOT IN (
         SELECT id FROM source_checks WHERE source_id = $1 ORDER BY checked_at DESC, id DESC LIMIT $2)`,
      [report.sourceId, KEPT_CHECKS],
    );
    await client.query(
      `UPDATE sources SET state = latest.report ->> 'state', state_reason = latest.report ->> 'stateReason'
       FROM (SELECT report FROM source_checks WHERE source_id = $1 ORDER BY checked_at DESC, id DESC LIMIT 1) AS latest
       WHERE sources.id = $1`,
      [report.sourceId],
    );
    await client.query('COMMIT');
  } catch (error) {
    // A failed rollback must not hide the error that caused it; the connection is released either way.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Marks a source as not checked since the start: the state `unknown` with the reason, and no check row. */
export async function markSourceUnchecked(db: pg.Pool, sourceId: string, reason: string): Promise<void> {
  await db.query(`UPDATE sources SET state = 'unknown', state_reason = $2 WHERE id = $1 AND removed_at IS NULL AND (state <> 'unknown' OR state_reason IS DISTINCT FROM $2)`, [sourceId, reason]);
}

/** A source as the running process knows it: what a stored check must carry to count for it. */
export interface CheckedSource {
  readonly id: string;
  readonly identityHash: string;
  readonly configHash: string;
}

export interface QualifyingCheck {
  readonly sourceId: string;
  readonly checkedAt: string;
  readonly report: SourceTestReport;
}

/**
 * The newest check of each source that counts for the running process: it reached the source, carries the source's current identity hash and config hash,
 * and was stored at or after `since`. One query for all sources; it reads Postgres only.
 */
export async function latestQualifyingChecks(db: pg.Pool, sources: readonly CheckedSource[], since: string, onUnreadable?: (sourceId: string, checkedAt: string) => void): Promise<QualifyingCheck[]> {
  if (sources.length === 0) return [];
  const result = await db.query<{ source_id: string; checked_at: Date; report: unknown }>(
    `SELECT DISTINCT ON (c.source_id) c.source_id, c.checked_at, c.report
       FROM source_checks c
       JOIN unnest($1::text[], $2::text[], $3::text[]) AS s(id, identity_hash, config_hash)
         ON s.id = c.source_id AND c.identity_hash = s.identity_hash AND c.config_hash = s.config_hash
      WHERE c.checked_at >= $4 AND jsonb_typeof(c.report -> 'server') = 'object'
      ORDER BY c.source_id, c.checked_at DESC, c.id DESC`,
    [sources.map((source) => source.id), sources.map((source) => source.identityHash), sources.map((source) => source.configHash), since],
  );
  // a row this version cannot read (a newer one wrote a field it does not know) is left out and reported, so it cannot hold back the other sources
  return result.rows.flatMap((row) => {
    try {
      return [{ sourceId: row.source_id, checkedAt: row.checked_at.toISOString(), report: readStoredReport(row.report) }];
    } catch {
      onUnreadable?.(row.source_id, row.checked_at.toISOString());
      return [];
    }
  });
}

/**
 * The newest check of each source made for the connection and the mapping it has now, whether or not it reached the source and whenever it was stored.
 * One query for all sources; it reads Postgres only. A row this version cannot read is left out and reported.
 */
export async function latestChecksFor(db: pg.Pool, sources: readonly CheckedSource[], onUnreadable?: (sourceId: string, checkedAt: string) => void): Promise<QualifyingCheck[]> {
  if (sources.length === 0) return [];
  const result = await db.query<{ source_id: string; checked_at: Date; report: unknown }>(
    `SELECT DISTINCT ON (c.source_id) c.source_id, c.checked_at, c.report
       FROM source_checks c
       JOIN unnest($1::text[], $2::text[], $3::text[]) AS s(id, identity_hash, config_hash)
         ON s.id = c.source_id AND c.identity_hash = s.identity_hash AND c.config_hash = s.config_hash
      ORDER BY c.source_id, c.checked_at DESC, c.id DESC`,
    [sources.map((source) => source.id), sources.map((source) => source.identityHash), sources.map((source) => source.configHash)],
  );
  return result.rows.flatMap((row) => {
    try {
      return [{ sourceId: row.source_id, checkedAt: row.checked_at.toISOString(), report: readStoredReport(row.report) }];
    } catch {
      onUnreadable?.(row.source_id, row.checked_at.toISOString());
      return [];
    }
  });
}

export interface PingStateChange {
  readonly sourceId: string;
  /** True when the ping reached the source. */
  readonly reachable: boolean;
  /** The fixed sentence of an unreachable ping. */
  readonly reason: string | null;
  /** When the ping's read started: a failed ping gives way to a test that was reached later. */
  readonly observedAt: string;
  /** The identity hash and the config hash of the source as this process runs it, and when this process started: only a check that matches and is not older counts when the ping restores the state. */
  readonly identityHash: string;
  readonly configHash: string;
  readonly since: string;
}

/**
 * Sets the state of a source from a ping, under the lock a test run takes: `unavailable` with the sentence when the ping failed;
 * when it succeeded, the state of the newest test that counts for the running process (see `latestQualifyingChecks`), or `unknown` with the reason that the source has not been checked since the start.
 * Writes only when the state would change, and leaves `updated_at` alone. Returns whether a row was changed.
 */
export async function applyPingState(db: pg.Pool, change: PingStateChange): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT 1 FROM sources WHERE id = $1 AND removed_at IS NULL FOR UPDATE', [change.sourceId]);
    const source = locked.rows[0];
    if (source === undefined) {
      await client.query('COMMIT');
      return false;
    }
    let state = 'unavailable';
    let reason: string | null = change.reason;
    if (!change.reachable) {
      const fresher = await client.query(`SELECT 1 FROM source_checks WHERE source_id = $1 AND checked_at > $2 LIMIT 1`, [change.sourceId, change.observedAt]);
      if ((fresher.rowCount ?? 0) > 0) {
        await client.query('COMMIT');
        return false;
      }
    } else {
      // the newest check that counts for this process (it reached the source, matches the identity and the mapping, was stored since the start), else not checked
      const newest = await client.query<{ state: string | null; reason: string | null }>(
        `SELECT report ->> 'state' AS state, report ->> 'stateReason' AS reason FROM source_checks
          WHERE source_id = $1 AND identity_hash = $2 AND config_hash = $3 AND checked_at >= $4 AND jsonb_typeof(report -> 'server') = 'object'
          ORDER BY checked_at DESC, id DESC LIMIT 1`,
        [change.sourceId, change.identityHash, change.configHash, change.since],
      );
      const row = newest.rows[0];
      state = row?.state ?? 'unknown';
      reason = row === undefined ? NOT_CHECKED_SINCE_START : row.reason;
    }
    const updated = await client.query(
      `UPDATE sources SET state = $2, state_reason = $3 WHERE id = $1 AND (state, state_reason) IS DISTINCT FROM ($2, $3)`,
      [change.sourceId, state, reason],
    );
    await client.query('COMMIT');
    return (updated.rowCount ?? 0) > 0;
  } catch (error) {
    // A failed rollback must not hide the error that caused it; the connection is released either way.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
