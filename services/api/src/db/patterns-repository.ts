import type pg from 'pg';
import { PATTERN_LIMITS, type AuditSink } from '@neburyx/contracts';
import { uuidv7 } from '../identity/uuid.js';
import { inTransaction } from './investigations-repository.js';
import { inPatternTransaction } from '../patterns/pattern-events.js';
import type { Principal } from '../seams/seams.js';

export type PatternKind = 'preset-run' | 'definition';

/** A saved pattern as it is stored. The anchor's stable id is the stored form of the reference. */
export interface PatternRow {
  readonly id: string;
  readonly ownerId: string;
  readonly sourceId: string;
  readonly name: string;
  readonly kind: PatternKind;
  readonly presetId: string | null;
  readonly templateId: string | null;
  readonly templateVersion: number | null;
  readonly params: Readonly<Record<string, unknown>> | null;
  readonly definition: Readonly<Record<string, unknown>> | null;
  readonly askForStartingEntity: boolean;
  readonly anchorEntityType: string | null;
  readonly anchorStableId: string | null;
  readonly visibility: 'private' | 'shared';
  readonly lastRunAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** What a write of a pattern needs of its caller: who changes it, the trace, and the seam the event is passed to after the commit. The store writes the pattern and its event in one transaction. */
export interface PatternWriteContext {
  readonly principal: Principal;
  readonly traceId: string;
  readonly audit: AuditSink;
}

export interface NewPattern {
  readonly sourceId: string;
  readonly name: string;
  readonly kind: PatternKind;
  readonly presetId: string | null;
  readonly templateId: string | null;
  readonly templateVersion: number | null;
  readonly params: Readonly<Record<string, unknown>> | null;
  readonly definition: Readonly<Record<string, unknown>> | null;
  readonly anchor: { readonly entityType: string; readonly stableId: string } | null;
}

export type PatternSaveResult = { readonly outcome: 'saved'; readonly row: PatternRow } | { readonly outcome: 'limit' };

/** Where a page of patterns starts: after the pattern changed at `updatedKey` (microsecond text, as the database holds it) with this `id`. */
export interface PatternListPosition {
  readonly updatedKey: string;
  readonly id: string;
}

export interface PatternListQuery {
  readonly ownerId: string;
  readonly sourceId: string;
  readonly limit: number;
  readonly after: PatternListPosition | undefined;
}

export interface PatternListResult {
  readonly rows: readonly PatternRow[];
  readonly next: PatternListPosition | undefined;
}

/** What a change sets: a field left out is kept. `anchor` of `null` clears the held entity and a value sets it (and the pattern then does not ask for it). */
export interface PatternChange {
  readonly id: string;
  readonly ownerId: string;
  readonly expectedVersion: number;
  readonly name?: string;
  readonly definition?: Readonly<Record<string, unknown>>;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly anchor?: { readonly entityType: string; readonly stableId: string } | null;
}

export type PatternChangeResult = { readonly outcome: 'changed'; readonly row: PatternRow } | { readonly outcome: 'not-found' } | { readonly outcome: 'conflict' };

export interface PatternDeletion {
  readonly id: string;
  readonly ownerId: string;
  readonly expectedVersion: number;
  /** Days from now to the purge: `retention.deleted_investigations_days`. */
  readonly retentionDays: number;
}

export type PatternDeleteResult = { readonly outcome: 'deleted'; readonly row: PatternRow; readonly deletedAt: string; readonly purgeAfter: string } | { readonly outcome: 'not-found' } | { readonly outcome: 'conflict' };

/** What the purge reports for each pattern it removes. */
export interface PurgedPattern {
  readonly id: string;
  readonly sourceId: string;
}

export interface PatternStore {
  /** Saves a pattern for the caller and records the `saved` event in the same transaction. The caller's patterns on the source are counted under a lock, so two saves cannot pass the limit together; a save over it writes nothing. */
  savePattern(input: NewPattern, context: PatternWriteContext): Promise<PatternSaveResult>;
  /** The owner's patterns on a source that are not deleted, the most recently changed first, then by id, one page and where the next starts. Another owner's patterns are never read. */
  listPatterns(query: PatternListQuery): Promise<PatternListResult>;
  /** The owner's pattern that is not deleted; another owner's, a deleted one and an unknown id are `undefined`. */
  readPattern(id: string, ownerId: string): Promise<PatternRow | undefined>;
  /** Changes the owner's pattern in one transaction under a lock on its row: the owner's live pattern, then the version, then the write and its `changed` event. A stale version writes nothing. */
  changePattern(change: PatternChange, context: PatternWriteContext): Promise<PatternChangeResult>;
  /** Marks the owner's pattern deleted (`deleted_at`, `purge_after`) under the same lock and guards, and records the `deleted` event. */
  deletePattern(deletion: PatternDeletion, context: PatternWriteContext): Promise<PatternDeleteResult>;
  /** Deletes the patterns whose purge date has passed, each in a transaction of its own that locks the row first (a row another transaction holds is left for the next run). `beforeDelete` runs inside that transaction, so a throw keeps the pattern and stops the run. No event row is written: the history of a pattern outlives it. Answers how many were deleted. */
  purgeExpiredPatterns(beforeDelete: (purged: PurgedPattern) => Promise<void>): Promise<number>;
}

export interface PatternRecord {
  readonly id: string;
  readonly owner_id: string;
  readonly source_id: string;
  readonly name: string;
  readonly kind: PatternKind;
  readonly preset_id: string | null;
  readonly template_id: string | null;
  readonly template_version: number | null;
  readonly params: Record<string, unknown> | null;
  readonly definition: Record<string, unknown> | null;
  readonly ask_for_starting_entity: boolean;
  readonly anchor_entity_type: string | null;
  readonly anchor_stable_id: string | null;
  readonly visibility: 'private' | 'shared';
  readonly last_run_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly version: number;
}

export const PATTERN_COLUMNS = `id, owner_id, source_id, name, kind, preset_id, template_id, template_version, params, definition, ask_for_starting_entity, anchor_entity_type, anchor_stable_id, visibility, last_run_at, created_at, updated_at, version`;

export function patternRowOf(record: PatternRecord): PatternRow {
  return {
    id: record.id,
    ownerId: record.owner_id,
    sourceId: record.source_id,
    name: record.name,
    kind: record.kind,
    presetId: record.preset_id,
    templateId: record.template_id,
    templateVersion: record.template_version,
    params: record.params,
    definition: record.definition,
    askForStartingEntity: record.ask_for_starting_entity,
    anchorEntityType: record.anchor_entity_type,
    anchorStableId: record.anchor_stable_id,
    visibility: record.visibility,
    lastRunAt: record.last_run_at === null ? null : record.last_run_at.toISOString(),
    createdAt: record.created_at.toISOString(),
    updatedAt: record.updated_at.toISOString(),
    version: record.version,
  };
}

export function createPatternStore(pool: pg.Pool): PatternStore {
  return {
    savePattern: (input, context) => savePattern(pool, input, context),
    listPatterns: (query) => listPatterns(pool, query),
    readPattern: (id, ownerId) => readPattern(pool, id, ownerId),
    changePattern: (change, context) => changePattern(pool, change, context),
    deletePattern: (deletion, context) => deletePattern(pool, deletion, context),
    purgeExpiredPatterns: (beforeDelete) => purgeExpiredPatterns(pool, beforeDelete),
  };
}

async function savePattern(pool: pg.Pool, input: NewPattern, context: PatternWriteContext): Promise<PatternSaveResult> {
  const ownerId = context.principal.id;
  return inPatternTransaction({ pool, audit: context.audit, newId: uuidv7 }, { principal: context.principal, traceId: context.traceId }, async (transaction) => {
    // one lock for the owner and the source: the count and the insert below are one step for every save of the pair
    await transaction.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`saved_patterns:${ownerId}:${input.sourceId}`]);
    const counted = await transaction.client.query<{ held: number }>('SELECT count(*)::int AS held FROM saved_patterns WHERE owner_id = $1 AND source_id = $2 AND deleted_at IS NULL', [ownerId, input.sourceId]);
    if ((counted.rows[0]?.held ?? 0) >= PATTERN_LIMITS.patternsPerSource) return { outcome: 'limit' } as const;
    const id = uuidv7();
    const inserted = await transaction.client.query<PatternRecord>(
      `INSERT INTO saved_patterns (id, owner_id, source_id, name, kind, preset_id, template_id, template_version, params, definition, ask_for_starting_entity, anchor_entity_type, anchor_stable_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${PATTERN_COLUMNS}`,
      [id, ownerId, input.sourceId, input.name, input.kind, input.presetId, input.templateId, input.templateVersion, input.params, input.definition, input.anchor === null, input.anchor?.entityType ?? null, input.anchor?.stableId ?? null],
    );
    const record = inserted.rows[0];
    if (record === undefined) throw new Error('the saved pattern was not returned');
    await transaction.record({ sourceId: input.sourceId, patternId: id, action: 'saved', version: 1 });
    return { outcome: 'saved', row: patternRowOf(record) } as const;
  });
}

const UPDATED_KEY = `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

async function listPatterns(pool: pg.Pool, query: PatternListQuery): Promise<PatternListResult> {
  const found = await pool.query<PatternRecord & { updated_key: string }>(
    `SELECT ${PATTERN_COLUMNS}, ${UPDATED_KEY} AS updated_key FROM saved_patterns
     WHERE owner_id = $1 AND source_id = $2 AND deleted_at IS NULL AND ($3::text IS NULL OR (updated_at, id) < ($3::timestamptz, $4::uuid))
     ORDER BY updated_at DESC, id DESC LIMIT $5`,
    [query.ownerId, query.sourceId, query.after?.updatedKey ?? null, query.after?.id ?? null, query.limit + 1],
  );
  const page = found.rows.slice(0, query.limit);
  const last = page.at(-1);
  return { rows: page.map(patternRowOf), next: found.rows.length > query.limit && last !== undefined ? { updatedKey: last.updated_key, id: last.id } : undefined };
}

async function readPattern(pool: pg.Pool, id: string, ownerId: string): Promise<PatternRow | undefined> {
  const found = await pool.query<PatternRecord>(`SELECT ${PATTERN_COLUMNS} FROM saved_patterns WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`, [id, ownerId]);
  const [record] = found.rows;
  return record === undefined ? undefined : patternRowOf(record);
}

async function lockPattern(client: pg.PoolClient, id: string, ownerId: string): Promise<PatternRecord | undefined> {
  const found = await client.query<PatternRecord>(`SELECT ${PATTERN_COLUMNS} FROM saved_patterns WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, ownerId]);
  return found.rows[0];
}

async function changePattern(pool: pg.Pool, change: PatternChange, context: PatternWriteContext): Promise<PatternChangeResult> {
  return inPatternTransaction({ pool, audit: context.audit, newId: uuidv7 }, { principal: context.principal, traceId: context.traceId }, async (transaction) => {
    const held = await lockPattern(transaction.client, change.id, change.ownerId);
    if (held === undefined) return { outcome: 'not-found' } as const;
    if (held.version !== change.expectedVersion) return { outcome: 'conflict' } as const;
    const sets: string[] = [];
    const values: unknown[] = [change.id];
    const set = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (change.name !== undefined) set('name', change.name);
    if (change.definition !== undefined) set('definition', change.definition);
    if (change.params !== undefined) set('params', change.params);
    if (change.anchor !== undefined) {
      set('anchor_entity_type', change.anchor?.entityType ?? null);
      set('anchor_stable_id', change.anchor?.stableId ?? null);
      set('ask_for_starting_entity', change.anchor === null);
    }
    const updated = await transaction.client.query<PatternRecord>(`UPDATE saved_patterns SET ${[...sets, 'version = version + 1', 'updated_at = clock_timestamp()'].join(', ')} WHERE id = $1 RETURNING ${PATTERN_COLUMNS}`, values);
    const record = updated.rows[0];
    if (record === undefined) throw new Error('the changed pattern was not returned');
    await transaction.record({ sourceId: record.source_id, patternId: record.id, action: 'changed', version: record.version });
    return { outcome: 'changed', row: patternRowOf(record) } as const;
  });
}

async function deletePattern(pool: pg.Pool, deletion: PatternDeletion, context: PatternWriteContext): Promise<PatternDeleteResult> {
  return inPatternTransaction({ pool, audit: context.audit, newId: uuidv7 }, { principal: context.principal, traceId: context.traceId }, async (transaction) => {
    const held = await lockPattern(transaction.client, deletion.id, deletion.ownerId);
    if (held === undefined) return { outcome: 'not-found' } as const;
    if (held.version !== deletion.expectedVersion) return { outcome: 'conflict' } as const;
    const updated = await transaction.client.query<PatternRecord & { deleted_at: Date; purge_after: Date }>(
      `UPDATE saved_patterns SET deleted_at = now(), purge_after = now() + make_interval(days => $2), version = version + 1, updated_at = clock_timestamp() WHERE id = $1 RETURNING ${PATTERN_COLUMNS}, deleted_at, purge_after`,
      [deletion.id, deletion.retentionDays],
    );
    const record = updated.rows[0];
    if (record === undefined) throw new Error('the deleted pattern was not returned');
    await transaction.record({ sourceId: record.source_id, patternId: record.id, action: 'deleted', version: record.version });
    return { outcome: 'deleted', row: patternRowOf(record), deletedAt: record.deleted_at.toISOString(), purgeAfter: record.purge_after.toISOString() } as const;
  });
}

const PURGE_PASS_SIZE = 100;

async function purgeOne(pool: pg.Pool, beforeDelete: (purged: PurgedPattern) => Promise<void>): Promise<boolean> {
  return inTransaction(pool, async (client) => {
    const found = await client.query<{ id: string; source_id: string }>(`SELECT id, source_id FROM saved_patterns WHERE deleted_at IS NOT NULL AND purge_after <= now() ORDER BY purge_after, id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    const [held] = found.rows;
    if (held === undefined) return false;
    await beforeDelete({ id: held.id, sourceId: held.source_id });
    await client.query(`DELETE FROM saved_patterns WHERE id = $1 AND deleted_at IS NOT NULL AND purge_after <= now()`, [held.id]);
    return true;
  });
}

async function purgeExpiredPatterns(pool: pg.Pool, beforeDelete: (purged: PurgedPattern) => Promise<void>): Promise<number> {
  let purged = 0;
  for (;;) {
    for (let inPass = 0; inPass < PURGE_PASS_SIZE; inPass += 1) {
      if (!(await purgeOne(pool, beforeDelete))) return purged;
      purged += 1;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
