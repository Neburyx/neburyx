import { sourceTestReportSchema, type SourceTestReport } from '@neburyx/contracts';
import type pg from 'pg';
import { AppError } from '../errors.js';

export const KEPT_CHECKS = 50;

export interface SourceCheck {
  readonly id: string;
  readonly report: SourceTestReport;
  readonly triggeredBy: string | null;
}

/** The text kept in `server_version`: `Neo4j <version>` for the Neo4j kernel and `<product> <version>` for any other product. */
export function serverVersionOf(report: SourceTestReport): string | null {
  if (report.server === null) return null;
  const product = report.server.product === 'Neo4j Kernel' ? 'Neo4j' : report.server.product;
  return `${product} ${report.server.version}`;
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
      `INSERT INTO source_checks (id, source_id, checked_at, triggered_by, outcome, server_version, read_only_check, report)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [check.id, report.sourceId, report.checkedAt, check.triggeredBy, report.outcome, serverVersionOf(report), report.readOnlyCheck, JSON.stringify(report)],
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
