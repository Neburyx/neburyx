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

export type PatternSaveResult = { readonly outcome: 'saved'; readonly row: PatternRow } | { readonly outcome: 'limit' } | { readonly outcome: 'name-taken' };

/** Where a page of patterns starts: after the pattern changed at `updatedKey` (microsecond text, as the database holds it) with this `id`. */
export interface PatternListPosition {
  readonly updatedKey: string;
  readonly id: string;
}

export interface PatternListQuery {
  /** The caller: their own patterns, and the shared patterns of other people, are listed. */
  readonly ownerId: string;
  readonly sourceId: string;
  readonly limit: number;
  readonly after: PatternListPosition | undefined;
}

/** A listed pattern: the row and its creator's current display name. */
export interface ListedPatternRow extends PatternRow {
  readonly ownerName: string;
}

export interface PatternListResult {
  readonly rows: readonly ListedPatternRow[];
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
  /** Makes the pattern visible to everyone on its source (`shared`) or to its creator only (`private`). */
  readonly visibility?: 'private' | 'shared';
  /** What the event records: `changed` (the default), or `shared` and `unshared` for a change of visibility. */
  readonly action?: 'changed' | 'shared' | 'unshared';
}

export type PatternChangeResult = { readonly outcome: 'changed'; readonly row: PatternRow } | { readonly outcome: 'not-found' } | { readonly outcome: 'conflict' } | { readonly outcome: 'name-taken' };

export interface PatternDeletion {
  readonly id: string;
  readonly ownerId: string;
  readonly expectedVersion: number;
  /** Days from now to the purge: `retention.deleted_investigations_days`. */
  readonly retentionDays: number;
}

/** The name of a pattern as the store compares it: Unicode form C, then lower case, spaces at its ends left out. The unique index of a person's names on a source is on the same, and where the database lower-cases a letter otherwise than this does, the database decides (through the index) and this only stands in for it in tests. */
export const patternNameKey = (name: string): string => [...name.replace(/^ +| +$/g, '').normalize('NFC')].map((character) => character.toLowerCase()).join('');

/** At most this many tries for the name of a copy that a concurrent rename takes between the choice of the name and the insert. */
const COPY_NAME_TRIES = 5;

export type PatternDeleteResult = { readonly outcome: 'deleted'; readonly row: PatternRow; readonly deletedAt: string; readonly purgeAfter: string } | { readonly outcome: 'not-found' } | { readonly outcome: 'conflict' };

/** What a copy needs: the original, the name of the copy from the original's name, and whether the original may be copied now. Both are decided on the row as it is read under the lock. */
export interface PatternCopy {
  readonly originalId: string;
  /** The name of the copy for the given try: the first try is the original's name with a suffix, each later one a number more; the store takes the first that the person's patterns on the source do not hold. */
  readonly nameOf: (originalName: string, attempt: number) => string;
  readonly accept: (original: PatternRow) => boolean;
}

export type PatternCopyResult =
  | { readonly outcome: 'copied'; readonly row: PatternRow; readonly original: PatternRow }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'refused' }
  | { readonly outcome: 'limit' }
  | { readonly outcome: 'name-taken' };

/** What the purge reports for each pattern it removes. */
export interface PurgedPattern {
  readonly id: string;
  readonly sourceId: string;
}

export interface PatternStore {
  /** Saves a pattern for the caller and records the `saved` event in the same transaction. The caller's patterns on the source are counted under a lock, so two saves cannot pass the limit together; a save over it writes nothing. */
  savePattern(input: NewPattern, context: PatternWriteContext): Promise<PatternSaveResult>;
  /** The caller's patterns on a source that are not deleted, and the shared patterns of other people on it, the most recently changed first, then by id, one page and where the next starts: the next position is the last row read. Another person's private pattern is never read. */
  listPatterns(query: PatternListQuery): Promise<PatternListResult>;
  /** The owner's pattern that is not deleted; another owner's, a deleted one and an unknown id are `undefined`. */
  readPattern(id: string, ownerId: string): Promise<PatternRow | undefined>;
  /** The live pattern a person may run: their own, or one whose visibility is `shared`, whoever owns it (the row says who). Another person's private pattern, a deleted one, an unknown id and an id that is not a uuid are `undefined`. */
  readRunnablePattern(id: string, principalId: string): Promise<PatternRow | undefined>;
  /** Records that the owner ran the pattern: `last_run_at` is now. It is a use and not an edit: the version, `updated_at` and the events are not touched. False, with nothing written, for anyone but the owner, a deleted pattern and an unknown id. */
  recordPatternRun(id: string, ownerId: string): Promise<boolean>;
  /** Copies a pattern the caller may see into a private pattern of theirs on the same source, under the caller's lock for the source and a share lock on the original, and records a `copied` event for the copy and one for the original. */
  copyPattern(copy: PatternCopy, context: PatternWriteContext): Promise<PatternCopyResult>;
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
    readRunnablePattern: (id, principalId) => readRunnablePattern(pool, id, principalId),
    recordPatternRun: (id, ownerId) => recordPatternRun(pool, id, ownerId),
    copyPattern: (copy, context) => copyPattern(pool, copy, context),
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
    const written = await unlessNameTaken(transaction.client, () =>
      transaction.client.query<PatternRecord>(
        `INSERT INTO saved_patterns (id, owner_id, source_id, name, kind, preset_id, template_id, template_version, params, definition, ask_for_starting_entity, anchor_entity_type, anchor_stable_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${PATTERN_COLUMNS}`,
        [id, ownerId, input.sourceId, input.name, input.kind, input.presetId, input.templateId, input.templateVersion, input.params, input.definition, input.anchor === null, input.anchor?.entityType ?? null, input.anchor?.stableId ?? null],
      ),
    );
    if (written.taken) return { outcome: 'name-taken' } as const;
    const record = written.value.rows[0];
    if (record === undefined) throw new Error('the saved pattern was not returned');
    await transaction.record({ sourceId: input.sourceId, patternId: id, action: 'saved', version: 1 });
    return { outcome: 'saved', row: patternRowOf(record) } as const;
  });
}

const UPDATED_KEY = `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

async function listPatterns(pool: pg.Pool, query: PatternListQuery): Promise<PatternListResult> {
  const half = (own: boolean): string =>
    `(SELECT ${PATTERN_COLUMNS}, ${UPDATED_KEY} AS updated_key FROM saved_patterns
      WHERE ${own ? 'owner_id = $1' : "owner_id <> $1 AND visibility = 'shared'"} AND source_id = $2 AND deleted_at IS NULL AND ($3::text IS NULL OR (updated_at, id) < ($3::timestamptz, $4::uuid))
      ORDER BY updated_at DESC, id DESC LIMIT $5)`;
  const found = await pool.query<PatternRecord & { updated_key: string; display_name: string }>(
    `SELECT merged.*, u.display_name FROM (${half(true)} UNION ALL ${half(false)}) merged JOIN users u ON u.id = merged.owner_id ORDER BY merged.updated_at DESC, merged.id DESC LIMIT $5`,
    [query.ownerId, query.sourceId, query.after?.updatedKey ?? null, query.after?.id ?? null, query.limit + 1],
  );
  const page = found.rows.slice(0, query.limit);
  const last = page.at(-1);
  return { rows: page.map((record) => ({ ...patternRowOf(record), ownerName: record.display_name })), next: found.rows.length > query.limit && last !== undefined ? { updatedKey: last.updated_key, id: last.id } : undefined };
}

async function readPattern(pool: pg.Pool, id: string, ownerId: string): Promise<PatternRow | undefined> {
  const found = await pool.query<PatternRecord>(`SELECT ${PATTERN_COLUMNS} FROM saved_patterns WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`, [id, ownerId]);
  const [record] = found.rows;
  return record === undefined ? undefined : patternRowOf(record);
}

const PATTERN_ID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readRunnablePattern(pool: pg.Pool, id: string, principalId: string): Promise<PatternRow | undefined> {
  if (!PATTERN_ID_TEXT.test(id) || !PATTERN_ID_TEXT.test(principalId)) return undefined;
  const found = await pool.query<PatternRecord>(`SELECT ${PATTERN_COLUMNS} FROM saved_patterns WHERE id = $1 AND deleted_at IS NULL AND (owner_id = $2 OR visibility = 'shared')`, [id, principalId]);
  const [record] = found.rows;
  return record === undefined ? undefined : patternRowOf(record);
}

async function recordPatternRun(pool: pg.Pool, id: string, ownerId: string): Promise<boolean> {
  if (!PATTERN_ID_TEXT.test(id) || !PATTERN_ID_TEXT.test(ownerId)) return false;
  const done = await pool.query('UPDATE saved_patterns SET last_run_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [id, ownerId]);
  return (done.rowCount ?? 0) > 0;
}

const NAME_INDEX = 'saved_patterns_owner_name';

function isNameTaken(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === NAME_INDEX;
}

/** Runs one write inside a savepoint: a name another of the person's patterns on the source holds (the unique index decides, not a read first) undoes only that write and is reported, so the transaction can go on; any other failure is thrown. */
async function unlessNameTaken<T>(client: pg.PoolClient, write: () => Promise<T>): Promise<{ readonly taken: false; readonly value: T } | { readonly taken: true }> {
  await client.query('SAVEPOINT pattern_name');
  try {
    const value = await write();
    await client.query('RELEASE SAVEPOINT pattern_name');
    return { taken: false, value };
  } catch (error) {
    if (!isNameTaken(error)) throw error;
    await client.query('ROLLBACK TO SAVEPOINT pattern_name');
    return { taken: true };
  }
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
    if (change.visibility !== undefined) set('visibility', change.visibility);
    if (change.definition !== undefined) set('definition', change.definition);
    if (change.params !== undefined) set('params', change.params);
    if (change.anchor !== undefined) {
      set('anchor_entity_type', change.anchor?.entityType ?? null);
      set('anchor_stable_id', change.anchor?.stableId ?? null);
      set('ask_for_starting_entity', change.anchor === null);
    }
    const written = await unlessNameTaken(transaction.client, () => transaction.client.query<PatternRecord>(`UPDATE saved_patterns SET ${[...sets, 'version = version + 1', 'updated_at = clock_timestamp()'].join(', ')} WHERE id = $1 RETURNING ${PATTERN_COLUMNS}`, values));
    if (written.taken) return { outcome: 'name-taken' } as const;
    const record = written.value.rows[0];
    if (record === undefined) throw new Error('the changed pattern was not returned');
    await transaction.record({ sourceId: record.source_id, patternId: record.id, action: change.action ?? 'changed', version: record.version });
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

async function nameHeld(client: pg.PoolClient, ownerId: string, sourceId: string, name: string): Promise<boolean> {
  const found = await client.query('SELECT 1 FROM saved_patterns WHERE owner_id = $1 AND source_id = $2 AND deleted_at IS NULL AND lower(normalize(btrim(name), NFC)) = lower(normalize(btrim($3::text), NFC)) LIMIT 1', [ownerId, sourceId, name]);
  return (found.rowCount ?? 0) > 0;
}

async function copyPattern(pool: pg.Pool, copy: PatternCopy, context: PatternWriteContext): Promise<PatternCopyResult> {
  const callerId = context.principal.id;
  return inPatternTransaction({ pool, audit: context.audit, newId: uuidv7 }, { principal: context.principal, traceId: context.traceId }, async (transaction) => {
    // the original is held while it is copied, so a pattern unshared or deleted at the same moment is not copied
    const found = await transaction.client.query<PatternRecord>(`SELECT ${PATTERN_COLUMNS} FROM saved_patterns WHERE id = $1 AND deleted_at IS NULL AND (owner_id = $2 OR visibility = 'shared') FOR SHARE`, [copy.originalId, callerId]);
    const record = found.rows[0];
    if (record === undefined) return { outcome: 'not-found' } as const;
    const original = patternRowOf(record);
    if (!copy.accept(original)) return { outcome: 'refused' } as const;
    await transaction.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`saved_patterns:${callerId}:${record.source_id}`]);
    const counted = await transaction.client.query<{ held: number }>('SELECT count(*)::int AS held FROM saved_patterns WHERE owner_id = $1 AND source_id = $2 AND deleted_at IS NULL', [callerId, record.source_id]);
    if ((counted.rows[0]?.held ?? 0) >= PATTERN_LIMITS.patternsPerSource) return { outcome: 'limit' } as const;
    const id = uuidv7();
    // the first name the person's patterns on the source do not hold; a concurrent rename may still take it before the insert, so a try that loses is followed by the next, up to a few
    let attempt = 0;
    let made: PatternRecord | undefined;
    for (let tries = 0; made === undefined && tries < COPY_NAME_TRIES; tries += 1) {
      let name: string;
      do {
        attempt += 1;
        name = copy.nameOf(record.name, attempt);
      } while (attempt <= PATTERN_LIMITS.patternsPerSource + 1 && (await nameHeld(transaction.client, callerId, record.source_id, name)));
      const written = await unlessNameTaken(transaction.client, () =>
        transaction.client.query<PatternRecord>(
          `INSERT INTO saved_patterns (id, owner_id, source_id, name, kind, preset_id, template_id, template_version, params, definition, ask_for_starting_entity, anchor_entity_type, anchor_stable_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${PATTERN_COLUMNS}`,
          [id, callerId, record.source_id, name, record.kind, record.preset_id, record.template_id, record.template_version, record.params, record.definition, record.ask_for_starting_entity, record.anchor_entity_type, record.anchor_stable_id],
        ),
      );
      if (!written.taken) made = written.value.rows[0];
    }
    if (made === undefined) return { outcome: 'name-taken' } as const;
    await transaction.record({ sourceId: made.source_id, patternId: made.id, action: 'copied', version: 1 });
    await transaction.record({ sourceId: record.source_id, patternId: record.id, action: 'copied', version: record.version });
    return { outcome: 'copied', row: patternRowOf(made), original } as const;
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
