import { layoutDocumentSchema, queryContextDocumentSchema, type InvestigationSave, type LayoutDocument, type QueryContextDocument } from '@neburyx/contracts';
import type pg from 'pg';
import { readOnlyStatusOf, type ReadOnlyStatus } from '../investigations/read-only.js';
import { lockLiveInvestigation } from './locks.js';
import { planStatusChange, type StatusChangePlan } from '../investigations/status-change.js';

export interface InvestigationRow {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceIdentityHash: string;
  readonly ownerId: string;
  readonly title: string;
  readonly caseRef: string | null;
  readonly startingEntityType: string | null;
  readonly startingStableId: string | null;
  readonly status: 'open' | 'closed' | 'archived';
  readonly createdAt: string;
  readonly lastEditedAt: string;
  readonly closedAt: string | null;
  readonly archivedAt: string | null;
  readonly version: number;
}

export interface DraftRow {
  readonly id: string;
  readonly version: number;
  readonly layout: unknown;
  readonly queryContext: unknown;
  readonly notes: string | null;
  readonly mappingHash: string;
  readonly basedOnViewId: string | null;
}

export interface NewDraft {
  readonly id: string;
  readonly layout: LayoutDocument;
  readonly queryContext: QueryContextDocument;
  readonly mappingHash: string;
  readonly contentHash: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly countsPolicyVersion: string;
}

export interface NewInvestigation {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceIdentityHash: string;
  readonly ownerId: string;
  readonly title: string;
  readonly caseRef: string | null;
  readonly startingEntityType: string;
  readonly startingStableId: string;
  readonly draft: NewDraft;
}

/** What a draft write replaces. `contentHashOf` is given the `ai_notes` the draft holds, which a write leaves as they are, and returns the hash of everything the Save dialog would snapshot. */
export interface DraftWrite {
  readonly investigationId: string;
  readonly ownerId: string;
  readonly expectedVersion: number;
  readonly layout: LayoutDocument;
  readonly queryContext: QueryContextDocument;
  readonly notes: string | null;
  readonly mappingHash: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly contentHashOf: (held: { readonly aiNotes: unknown }) => string;
}

/** `unchanged` is a write whose content equals the stored one: nothing was written and `version` is the one that was sent. */
export type DraftWriteResult = { readonly outcome: 'saved' | 'unchanged'; readonly version: number; readonly save: InvestigationSave } | { readonly outcome: 'conflict' } | { readonly outcome: 'not-found' } | { readonly outcome: 'read-only'; readonly status: ReadOnlyStatus };

/** What a title change or a status change asks of the investigation of `investigationId`. */
export interface InvestigationChange {
  readonly investigationId: string;
  readonly ownerId: string;
  readonly expectedVersion: number;
}

export interface TitleChange extends InvestigationChange {
  readonly title: string;
}

export interface StatusChange extends InvestigationChange {
  readonly status: InvestigationRow['status'];
}

/** `unchanged` is a change to what the investigation already has: nothing was written and `row` is as stored. */
export type TitleChangeResult = { readonly outcome: 'renamed' | 'unchanged'; readonly row: InvestigationRow } | { readonly outcome: 'conflict' } | { readonly outcome: 'not-found' } | { readonly outcome: 'read-only'; readonly status: ReadOnlyStatus };

export type StatusChangeResult = { readonly outcome: 'changed' | 'unchanged'; readonly row: InvestigationRow } | { readonly outcome: 'conflict' } | { readonly outcome: 'not-allowed' } | { readonly outcome: 'not-found' };

export interface DeleteChange extends InvestigationChange {
  readonly retentionDays: number;
  /** Runs inside the transaction before it commits, with the row as deleted; a throw rolls the delete back. */
  readonly beforeCommit: (row: InvestigationRow) => Promise<void>;
}

export interface RestoreChange extends InvestigationChange {
  readonly beforeCommit: (row: InvestigationRow) => Promise<void>;
}

/** `deletedAt` and `purgeAfter` are the database's times of the delete and of the last moment it can be restored. */
export type DeleteResult = { readonly outcome: 'deleted'; readonly row: InvestigationRow; readonly deletedAt: string; readonly purgeAfter: string } | { readonly outcome: 'conflict' } | { readonly outcome: 'not-found' };

export type RestoreResult = { readonly outcome: 'restored'; readonly row: InvestigationRow } | { readonly outcome: 'conflict' } | { readonly outcome: 'not-found' };

export interface PurgedInvestigation {
  readonly id: string;
  readonly sourceId: string;
}

export interface ReusableQuery {
  readonly ownerId: string;
  readonly sourceId: string;
  readonly caseRef: string;
  readonly entityType: string;
  readonly stableId: string;
}

/** `created` is false when the owner already had an open investigation for the same source, case reference and starting entity, and `row` is that one. */
export interface CreatedInvestigation {
  readonly row: InvestigationRow;
  readonly created: boolean;
}

export interface StoredInvestigation {
  readonly investigation: InvestigationRow;
  readonly draft: DraftRow;
  /** When the named view the draft equals was made, or null when the draft equals none. */
  readonly savedAt: string | null;
}

export interface ListedInvestigation extends InvestigationRow {
  readonly deletedAt?: string;
  readonly purgeAfter?: string;
  readonly sourceAlias: string;
  readonly save: InvestigationSave;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly countsPolicyVersion: string;
  /** `lastEditedAt` as the database holds it, in microseconds, so the next page starts after exactly this row. */
  readonly lastEditedKey: string;
}

/** Where a page of the list starts: after the row last edited at `editedKey` (microsecond text) with this `id`. */
export interface ListPosition {
  readonly editedKey: string;
  readonly id: string;
}

/** Where a page of the deleted list starts: after the row deleted at `editedKey` (microsecond text) with this `id`. */
export interface DeletedListQuery {
  readonly ownerId: string;
  readonly sourceIds: readonly string[];
  readonly sourceId: string | undefined;
  readonly text: string | undefined;
  readonly limit: number;
  readonly after: ListPosition | undefined;
}

export type DeletedMatchQuery = Omit<DeletedListQuery, 'limit' | 'after'>;

export interface ListFilters {
  readonly status: 'open' | 'closed' | 'archived';
  readonly sourceId: string | undefined;
  /** A fragment of the title or the case reference. */
  readonly text: string | undefined;
}

export interface ListQuery extends ListFilters {
  readonly ownerId: string;
  readonly sourceIds: readonly string[];
  readonly limit: number;
  readonly after: ListPosition | undefined;
}

export type MatchQuery = Omit<ListQuery, 'limit' | 'after'>;

export interface CountQuery {
  readonly ownerId: string;
  readonly sourceIds: readonly string[];
}

export interface InvestigationCounts {
  readonly investigations: number;
  readonly sources: number;
}

export interface NamedViewCounts {
  readonly views: number;
  readonly lastEditedAt: string | null;
}

/** The reads of one list call, all at the snapshot the first of them took. */
export interface LibraryReader {
  listInvestigationSourceIds(ownerId: string): Promise<string[]>;
  listInvestigations(query: ListQuery): Promise<ListedInvestigation[]>;
  countMatching(query: MatchQuery): Promise<number>;
  countInvestigations(query: CountQuery): Promise<InvestigationCounts>;
  countNamedViews(query: CountQuery): Promise<NamedViewCounts>;
  listDeletedInvestigationSourceIds(ownerId: string): Promise<string[]>;
  listDeletedInvestigations(query: DeletedListQuery): Promise<ListedInvestigation[]>;
  countDeletedMatching(query: DeletedMatchQuery): Promise<number>;
}

export interface InvestigationStore {
  /** Writes the investigation and its draft, or, when the input has a case reference and the owner already has an open investigation for it, returns that one and writes nothing. The two are decided in one step, so two calls at once make one investigation. */
  createInvestigation(input: NewInvestigation): Promise<CreatedInvestigation>;
  findReusableInvestigation(query: ReusableQuery): Promise<InvestigationRow | undefined>;
  readInvestigation(id: string, ownerId: string): Promise<StoredInvestigation | undefined>;
  /** Replaces the owner's draft when `expectedVersion` is its version, in one transaction under a lock on the draft row, so two writes with one version make one winner. `last_edited_at` of the investigation moves only when the content changed. */
  saveDraft(write: DraftWrite): Promise<DraftWriteResult>;
  /** Changes the title in one transaction under a lock on the investigation: the order of checks is the owner's investigation, then read-only, then the version. `last_edited_at` does not move. */
  renameInvestigation(change: TitleChange): Promise<TitleChangeResult>;
  /** Moves the investigation to another status in one transaction under a lock on the investigation; a request for its current status writes nothing, and a stale `expectedVersion` is a conflict. `last_edited_at` does not move. */
  changeInvestigationStatus(change: StatusChange): Promise<StatusChangeResult>;
  /** Marks the investigation deleted in one statement, guarded by its live row and `expectedVersion`, whatever its status; the draft, the views and `last_edited_at` are not touched. A stale version is a conflict; an investigation that is not the owner's, unknown or already deleted is not found. */
  deleteInvestigation(change: DeleteChange): Promise<DeleteResult>;
  /** Clears the deletion in one statement, guarded by the row being deleted, not yet past `purge_after` by the database's clock, and `expectedVersion`; the purge's own predicate is the opposite, so one of the two takes the row. */
  restoreInvestigation(change: RestoreChange): Promise<RestoreResult>;
  /** Deletes the investigations whose purge date has passed, each in a transaction of its own that locks the row first (rows another transaction holds are left for the next run), with the views and the draft following by cascade. `beforeDelete` runs inside that transaction, so a throw keeps the investigation and stops the run. Answers how many were deleted. */
  purgeExpiredInvestigations(beforeDelete: (purged: PurgedInvestigation) => Promise<void>): Promise<number>;
  /** Runs the reads of one list call at one snapshot; what they return is not changed by an investigation another call creates meanwhile. */
  readLibrary<T>(read: (reader: LibraryReader) => Promise<T>): Promise<T>;
}

interface InvestigationRecord {
  readonly id: string;
  readonly source_id: string;
  readonly source_identity_hash: string;
  readonly owner_id: string;
  readonly title: string;
  readonly case_ref: string | null;
  readonly starting_entity_type: string | null;
  readonly starting_stable_id: string | null;
  readonly status: InvestigationRow['status'];
  readonly created_at: Date;
  readonly last_edited_at: Date;
  readonly closed_at: Date | null;
  readonly archived_at: Date | null;
  readonly version: number;
}

const COLUMNS = `id, source_id, source_identity_hash, owner_id, title, case_ref, starting_entity_type, starting_stable_id, status, created_at, last_edited_at, closed_at, archived_at, version`;
const QUALIFIED_COLUMNS = COLUMNS.split(', ').map((column) => `i.${column}`).join(', ');

function rowOf(record: InvestigationRecord): InvestigationRow {
  return {
    id: record.id,
    sourceId: record.source_id,
    sourceIdentityHash: record.source_identity_hash,
    ownerId: record.owner_id,
    title: record.title,
    caseRef: record.case_ref,
    startingEntityType: record.starting_entity_type,
    startingStableId: record.starting_stable_id,
    status: record.status,
    createdAt: record.created_at.toISOString(),
    lastEditedAt: record.last_edited_at.toISOString(),
    closedAt: record.closed_at === null ? null : record.closed_at.toISOString(),
    archivedAt: record.archived_at === null ? null : record.archived_at.toISOString(),
    version: record.version,
  };
}

/** The draft as it will be written, after its documents are checked against their schemas: a document that does not fit is refused here, before any row is written. */
export function validatedDraft(draft: NewDraft): NewDraft {
  return { ...draft, layout: layoutDocumentSchema.parse(draft.layout), queryContext: queryContextDocumentSchema.parse(draft.queryContext) };
}

interface Queryable {
  query<R extends pg.QueryResultRow>(text: string, values: unknown[]): Promise<pg.QueryResult<R>>;
}

async function newestReusable(db: Queryable, query: ReusableQuery): Promise<InvestigationRow | undefined> {
  const result = await db.query<InvestigationRecord>(
    `SELECT ${COLUMNS} FROM investigations
     WHERE owner_id = $1 AND source_id = $2 AND case_ref = $3 AND starting_entity_type = $4 AND starting_stable_id = $5 AND status = 'open' AND deleted_at IS NULL
     ORDER BY last_edited_at DESC, id DESC LIMIT 1`,
    [query.ownerId, query.sourceId, query.caseRef, query.entityType, query.stableId],
  );
  const [row] = result.rows;
  return row === undefined ? undefined : rowOf(row);
}

/**
 * Writes the investigation and its draft in one transaction, so a failure of the second insert leaves neither. With a case reference the lookup of an investigation to reuse is made in the same transaction under a lock on the owner, source, case reference and starting entity, so concurrent calls for them make one investigation.
 */
export async function createInvestigation(pool: pg.Pool, input: NewInvestigation): Promise<CreatedInvestigation> {
  const draft = validatedDraft(input.draft);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (input.caseRef !== null) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['open-investigation', input.ownerId, input.sourceId, input.caseRef, input.startingEntityType, input.startingStableId])]);
      const existing = await newestReusable(client, { ownerId: input.ownerId, sourceId: input.sourceId, caseRef: input.caseRef, entityType: input.startingEntityType, stableId: input.startingStableId });
      if (existing !== undefined) {
        await client.query('COMMIT');
        return { row: existing, created: false };
      }
    }
    const created = await client.query<InvestigationRecord>(
      `INSERT INTO investigations (id, source_id, source_identity_hash, owner_id, title, case_ref, starting_entity_type, starting_stable_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
      [input.id, input.sourceId, input.sourceIdentityHash, input.ownerId, input.title, input.caseRef, input.startingEntityType, input.startingStableId],
    );
    await client.query(
      `INSERT INTO saved_views (id, investigation_id, kind, layout, query_context, mapping_hash, content_hash, node_count, edge_count, counts_policy_version, created_by)
       VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [draft.id, input.id, JSON.stringify(draft.layout), JSON.stringify(draft.queryContext), draft.mappingHash, draft.contentHash, draft.nodeCount, draft.edgeCount, draft.countsPolicyVersion, input.ownerId],
    );
    await client.query('COMMIT');
    const [row] = created.rows;
    if (row === undefined) throw new Error('the investigation was not returned by its insert');
    return { row: rowOf(row), created: true };
  } catch (error) {
    // A failed rollback must not hide the error that caused it; the connection is released either way.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The caller's own open, undeleted investigation with this source, case reference and starting entity; the newest if there is more than one. */
export function findReusableInvestigation(db: pg.Pool, query: ReusableQuery): Promise<InvestigationRow | undefined> {
  return newestReusable(db, query);
}

interface StoredRecord extends InvestigationRecord {
  readonly draft_id: string;
  readonly draft_version: number;
  readonly layout: unknown;
  readonly query_context: unknown;
  readonly notes: string | null;
  readonly mapping_hash: string;
  readonly based_on_view_id: string | null;
  readonly saved_at: Date | null;
}

export async function readInvestigation(db: pg.Pool, id: string, ownerId: string): Promise<StoredInvestigation | undefined> {
  const result = await db.query<StoredRecord>(
    `SELECT ${QUALIFIED_COLUMNS}, v.id AS draft_id, v.version AS draft_version, v.layout, v.query_context, v.notes, v.mapping_hash, named.id AS based_on_view_id, CASE WHEN named.content_hash = v.content_hash THEN named.created_at END AS saved_at
     FROM investigations i JOIN saved_views v ON v.investigation_id = i.id AND v.kind = 'draft' AND v.created_by = i.owner_id
     LEFT JOIN saved_views named ON named.id = v.based_on_view_id AND named.kind = 'named' AND named.deleted_at IS NULL
     WHERE i.id = $1 AND i.owner_id = $2 AND i.deleted_at IS NULL`,
    [id, ownerId],
  );
  const [record] = result.rows;
  if (record === undefined) return undefined;
  return { investigation: rowOf(record), draft: { id: record.draft_id, version: record.draft_version, layout: record.layout, queryContext: record.query_context, notes: record.notes, basedOnViewId: record.based_on_view_id, mappingHash: record.mapping_hash }, savedAt: record.saved_at === null ? null : record.saved_at.toISOString() };
}

interface DraftRecord {
  readonly id: string;
  readonly version: number;
  readonly content_hash: string;
  readonly notes: string | null;
  readonly ai_notes: unknown;
  readonly mapping_hash: string;
  readonly saved_at: Date | null;
  readonly investigation_status: InvestigationRow['status'];
}

const DRAFT_STATE = `SELECT i.status AS investigation_status, draft.id, draft.version, draft.content_hash, draft.notes, draft.ai_notes, draft.mapping_hash, CASE WHEN named.content_hash = draft.content_hash THEN named.created_at END AS saved_at
     FROM saved_views draft
     JOIN investigations i ON i.id = draft.investigation_id AND i.owner_id = draft.created_by
     LEFT JOIN saved_views named ON named.id = draft.based_on_view_id AND named.kind = 'named' AND named.deleted_at IS NULL
     WHERE i.id = $1 AND i.owner_id = $2 AND i.deleted_at IS NULL AND draft.kind = 'draft'`;

const saveOf = (savedAt: Date | null): InvestigationSave => (savedAt === null ? { state: 'unsaved', savedAt: null } : { state: 'saved', savedAt: savedAt.toISOString() });

export async function saveDraft(pool: pg.Pool, write: DraftWrite): Promise<DraftWriteResult> {
  const layout = layoutDocumentSchema.parse(write.layout);
  const queryContext = queryContextDocumentSchema.parse(write.queryContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockLiveInvestigation(client, write.investigationId, write.ownerId);
    const found = await client.query<DraftRecord>(`${DRAFT_STATE} FOR UPDATE OF draft`, [write.investigationId, write.ownerId]);
    const [held] = found.rows;
    if (held === undefined) {
      await client.query('ROLLBACK');
      return { outcome: 'not-found' };
    }
    const readOnly = readOnlyStatusOf(held.investigation_status);
    if (readOnly !== undefined) {
      await client.query('ROLLBACK');
      return { outcome: 'read-only', status: readOnly };
    }
    if (held.version !== write.expectedVersion) {
      await client.query('ROLLBACK');
      return { outcome: 'conflict' };
    }
    const contentHash = write.contentHashOf({ aiNotes: held.ai_notes });
    if (contentHash === held.content_hash) {
      if (held.mapping_hash === write.mappingHash) {
        await client.query('COMMIT');
        return { outcome: 'unchanged', version: held.version, save: saveOf(held.saved_at) };
      }
      // the content is the same but was written under another mapping: only the hash moves, and the investigation's last edit does not
      await client.query(`UPDATE saved_views SET mapping_hash = $2, version = version + 1, updated_at = now() WHERE id = $1`, [held.id, write.mappingHash]);
      const rehashed = await client.query<DraftRecord>(DRAFT_STATE, [write.investigationId, write.ownerId]);
      await client.query('COMMIT');
      const [current] = rehashed.rows;
      if (current === undefined) throw new Error('the draft was not returned after its write');
      return { outcome: 'saved', version: current.version, save: saveOf(current.saved_at) };
    }
    await client.query(
      `UPDATE saved_views SET layout = $2, query_context = $3, notes = $8, mapping_hash = $4, content_hash = $5, node_count = $6, edge_count = $7, version = version + 1, updated_at = now() WHERE id = $1`,
      [held.id, JSON.stringify(layout), JSON.stringify(queryContext), write.mappingHash, contentHash, write.nodeCount, write.edgeCount, write.notes],
    );
    await client.query(`UPDATE investigations SET last_edited_at = now() WHERE id = $1`, [write.investigationId]);
    const after = await client.query<DraftRecord>(DRAFT_STATE, [write.investigationId, write.ownerId]);
    await client.query('COMMIT');
    const [now] = after.rows;
    if (now === undefined) throw new Error('the draft was not returned after its write');
    return { outcome: 'saved', version: now.version, save: saveOf(now.saved_at) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Runs `work` in a transaction on one connection; a throw rolls back, and the error that caused it is the one reported. */
export async function inTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const answer = await work(client);
    await client.query('COMMIT');
    return answer;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function lockInvestigation(client: pg.PoolClient, change: InvestigationChange): Promise<InvestigationRow | undefined> {
  const found = await client.query<InvestigationRecord>(`SELECT ${COLUMNS} FROM investigations WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR UPDATE`, [change.investigationId, change.ownerId]);
  const [record] = found.rows;
  return record === undefined ? undefined : rowOf(record);
}

export async function renameInvestigation(pool: pg.Pool, change: TitleChange): Promise<TitleChangeResult> {
  return inTransaction(pool, async (client) => {
    const held = await lockInvestigation(client, change);
    if (held === undefined) return { outcome: 'not-found' };
    const readOnly = readOnlyStatusOf(held.status);
    if (readOnly !== undefined) return { outcome: 'read-only', status: readOnly };
    if (held.version !== change.expectedVersion) return { outcome: 'conflict' };
    if (held.title === change.title) return { outcome: 'unchanged', row: held };
    const updated = await client.query<InvestigationRecord>(`UPDATE investigations SET title = $2, version = version + 1 WHERE id = $1 RETURNING ${COLUMNS}`, [change.investigationId, change.title]);
    const [record] = updated.rows;
    if (record === undefined) throw new Error('the investigation was not returned after its rename');
    return { outcome: 'renamed', row: rowOf(record) };
  });
}

const TIME_COLUMN_SQL: Readonly<Record<StatusChangePlan['closedAt'], (column: string) => string>> = {
  keep: (column) => column,
  now: () => 'now()',
  clear: () => 'NULL',
};

export async function changeInvestigationStatus(pool: pg.Pool, change: StatusChange): Promise<StatusChangeResult> {
  return inTransaction(pool, async (client) => {
    const held = await lockInvestigation(client, change);
    if (held === undefined) return { outcome: 'not-found' };
    const plan = planStatusChange(held.status, change.status);
    if (plan === 'unchanged') return { outcome: 'unchanged', row: held };
    if (held.version !== change.expectedVersion) return { outcome: 'conflict' };
    if (plan === 'not-allowed') return { outcome: 'not-allowed' };
    const updated = await client.query<InvestigationRecord>(
      `UPDATE investigations SET status = $2, closed_at = ${TIME_COLUMN_SQL[plan.closedAt]('closed_at')}, archived_at = ${TIME_COLUMN_SQL[plan.archivedAt]('archived_at')}, version = version + 1 WHERE id = $1 RETURNING ${COLUMNS}`,
      [change.investigationId, change.status],
    );
    const [record] = updated.rows;
    if (record === undefined) throw new Error('the investigation was not returned after its status change');
    return { outcome: 'changed', row: rowOf(record) };
  });
}

export async function deleteInvestigation(pool: pg.Pool, change: DeleteChange): Promise<DeleteResult> {
  return inTransaction(pool, async (client) => {
    const updated = await client.query<InvestigationRecord & { deleted_at: Date; purge_after: Date }>(
      `UPDATE investigations SET deleted_at = now(), purge_after = now() + make_interval(days => $4), deleted_by = $2, version = version + 1
       WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL AND version = $3
       RETURNING ${COLUMNS}, deleted_at, purge_after`,
      [change.investigationId, change.ownerId, change.expectedVersion, change.retentionDays],
    );
    const [record] = updated.rows;
    if (record === undefined) {
      const live = await client.query(`SELECT 1 FROM investigations WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`, [change.investigationId, change.ownerId]);
      return live.rowCount === 0 ? { outcome: 'not-found' } : { outcome: 'conflict' };
    }
    const row = rowOf(record);
    await change.beforeCommit(row);
    return { outcome: 'deleted', row, deletedAt: record.deleted_at.toISOString(), purgeAfter: record.purge_after.toISOString() };
  });
}

export async function restoreInvestigation(pool: pg.Pool, change: RestoreChange): Promise<RestoreResult> {
  return inTransaction(pool, async (client) => {
    const updated = await client.query<InvestigationRecord>(
      `UPDATE investigations SET deleted_at = NULL, purge_after = NULL, deleted_by = NULL, version = version + 1
       WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL AND purge_after > now() AND version = $3
       RETURNING ${COLUMNS}`,
      [change.investigationId, change.ownerId, change.expectedVersion],
    );
    const [record] = updated.rows;
    if (record === undefined) {
      const restorable = await client.query(`SELECT 1 FROM investigations WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL AND purge_after > now()`, [change.investigationId, change.ownerId]);
      return restorable.rowCount === 0 ? { outcome: 'not-found' } : { outcome: 'conflict' };
    }
    const row = rowOf(record);
    await change.beforeCommit(row);
    return { outcome: 'restored', row };
  });
}

interface ListedRecord extends InvestigationRecord {
  readonly source_alias: string;
  readonly last_edited_key: string;
  readonly node_count: number | null;
  readonly edge_count: number | null;
  readonly counts_policy_version: string | null;
  readonly saved_at: Date | null;
}

export async function listInvestigationSourceIds(db: pg.Pool | pg.PoolClient, ownerId: string): Promise<string[]> {
  const result = await db.query<{ source_id: string }>(`SELECT DISTINCT source_id FROM investigations WHERE owner_id = $1 AND deleted_at IS NULL`, [ownerId]);
  return result.rows.map((record) => record.source_id);
}

const EDITED_KEY = `to_char(i.last_edited_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const FILTER_WHERE = `i.owner_id = $1 AND i.source_id = ANY($2::text[]) AND i.status = $3 AND i.deleted_at IS NULL
     AND ($4::text IS NULL OR i.source_id = $4)
     AND ($5::text IS NULL OR i.title ILIKE $5 OR i.case_ref ILIKE $5)`;

/** The text becomes an ILIKE pattern that matches it as a fragment, with `\`, `%` and `_` standing for themselves. */
export function containsPattern(text: string | undefined): string | null {
  return text === undefined ? null : `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}

const filterParameters = (query: MatchQuery) => [query.ownerId, [...query.sourceIds], query.status, query.sourceId ?? null, containsPattern(query.text)];

export async function listInvestigations(db: pg.Pool | pg.PoolClient, query: ListQuery): Promise<ListedInvestigation[]> {
  const after = query.after;
  const result = await db.query<ListedRecord>(
    `SELECT ${QUALIFIED_COLUMNS}, s.alias AS source_alias, ${EDITED_KEY} AS last_edited_key,
            draft.node_count, draft.edge_count, draft.counts_policy_version,
            CASE WHEN named.content_hash = draft.content_hash THEN named.created_at END AS saved_at
     FROM investigations i
     JOIN sources s ON s.id = i.source_id
     LEFT JOIN saved_views draft ON draft.investigation_id = i.id AND draft.kind = 'draft' AND draft.created_by = i.owner_id
     LEFT JOIN saved_views named ON named.id = draft.based_on_view_id AND named.kind = 'named' AND named.deleted_at IS NULL
     WHERE ${FILTER_WHERE}
       AND ($6::text IS NULL OR (i.last_edited_at, i.id) < ($6::timestamptz, $7::uuid))
     ORDER BY i.last_edited_at DESC, i.id DESC
     LIMIT $8`,
    [...filterParameters(query), after?.editedKey ?? null, after?.id ?? null, query.limit],
  );
  return result.rows.map((record) => ({
    ...rowOf(record),
    sourceAlias: record.source_alias,
    save: record.saved_at === null ? { state: 'unsaved', savedAt: null } : { state: 'saved', savedAt: record.saved_at.toISOString() },
    nodeCount: record.node_count ?? 0,
    edgeCount: record.edge_count ?? 0,
    countsPolicyVersion: record.counts_policy_version ?? '',
    lastEditedKey: record.last_edited_key,
  }));
}

export async function countMatching(db: pg.Pool | pg.PoolClient, query: MatchQuery): Promise<number> {
  const result = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM investigations i WHERE ${FILTER_WHERE}`, filterParameters(query));
  return result.rows[0]?.total ?? 0;
}

export async function countInvestigations(db: pg.Pool | pg.PoolClient, query: CountQuery): Promise<InvestigationCounts> {
  const result = await db.query<{ investigations: number; sources: number }>(
    `SELECT count(*)::int AS investigations, count(DISTINCT source_id)::int AS sources
     FROM investigations
     WHERE owner_id = $1 AND source_id = ANY($2::text[]) AND status = 'open' AND deleted_at IS NULL`,
    [query.ownerId, [...query.sourceIds]],
  );
  const [row] = result.rows;
  if (row === undefined) throw new Error('the counts were not returned');
  return { investigations: row.investigations, sources: row.sources };
}

export async function countNamedViews(db: pg.Pool | pg.PoolClient, query: CountQuery): Promise<NamedViewCounts> {
  const result = await db.query<{ views: number; last_edited_at: Date | null }>(
    `SELECT count(*)::int AS views, max(v.updated_at) AS last_edited_at
     FROM saved_views v
     JOIN investigations i ON i.id = v.investigation_id
     WHERE v.kind = 'named' AND v.deleted_at IS NULL AND i.owner_id = $1 AND i.source_id = ANY($2::text[]) AND i.deleted_at IS NULL`,
    [query.ownerId, [...query.sourceIds]],
  );
  const [row] = result.rows;
  if (row === undefined) throw new Error('the named view counts were not returned');
  return { views: row.views, lastEditedAt: row.last_edited_at === null ? null : row.last_edited_at.toISOString() };
}

export async function listDeletedInvestigationSourceIds(db: pg.Pool | pg.PoolClient, ownerId: string): Promise<string[]> {
  const result = await db.query<{ source_id: string }>(`SELECT DISTINCT source_id FROM investigations WHERE owner_id = $1 AND deleted_at IS NOT NULL AND purge_after > now()`, [ownerId]);
  return result.rows.map((record) => record.source_id);
}

const DELETED_KEY = `to_char(i.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const DELETED_WHERE = `i.owner_id = $1 AND i.source_id = ANY($2::text[]) AND i.deleted_at IS NOT NULL AND i.purge_after > now()
     AND ($3::text IS NULL OR i.source_id = $3)
     AND ($4::text IS NULL OR i.title ILIKE $4 OR i.case_ref ILIKE $4)`;

const deletedParameters = (query: DeletedMatchQuery) => [query.ownerId, [...query.sourceIds], query.sourceId ?? null, containsPattern(query.text)];

export async function listDeletedInvestigations(db: pg.Pool | pg.PoolClient, query: DeletedListQuery): Promise<ListedInvestigation[]> {
  const after = query.after;
  const result = await db.query<ListedRecord & { deleted_at: Date; purge_after: Date }>(
    `SELECT ${QUALIFIED_COLUMNS}, i.deleted_at, i.purge_after, s.alias AS source_alias, ${DELETED_KEY} AS last_edited_key,
            CASE WHEN named.content_hash = draft.content_hash AND named.deleted_at IS NULL THEN named.created_at END AS saved_at
     FROM investigations i
     JOIN sources s ON s.id = i.source_id
     LEFT JOIN saved_views draft ON draft.investigation_id = i.id AND draft.kind = 'draft' AND draft.created_by = i.owner_id
     LEFT JOIN saved_views named ON named.id = draft.based_on_view_id AND named.kind = 'named' AND named.deleted_at IS NULL
     WHERE ${DELETED_WHERE}
       AND ($5::text IS NULL OR (i.deleted_at, i.id) < ($5::timestamptz, $6::uuid))
     ORDER BY i.deleted_at DESC, i.id DESC
     LIMIT $7`,
    [...deletedParameters(query), after?.editedKey ?? null, after?.id ?? null, query.limit],
  );
  return result.rows.map((record) => ({
    ...rowOf(record),
    deletedAt: record.deleted_at.toISOString(),
    purgeAfter: record.purge_after.toISOString(),
    sourceAlias: record.source_alias,
    save: record.saved_at === null ? { state: 'unsaved', savedAt: null } : { state: 'saved', savedAt: record.saved_at.toISOString() },
    nodeCount: 0,
    edgeCount: 0,
    countsPolicyVersion: '',
    lastEditedKey: record.last_edited_key,
  }));
}

export async function countDeletedMatching(db: pg.Pool | pg.PoolClient, query: DeletedMatchQuery): Promise<number> {
  const result = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM investigations i WHERE ${DELETED_WHERE}`, deletedParameters(query));
  return result.rows[0]?.total ?? 0;
}

const PURGE_PASS_SIZE = 100;

async function purgeOne(pool: pg.Pool, beforeDelete: (purged: PurgedInvestigation) => Promise<void>): Promise<boolean> {
  return inTransaction(pool, async (client) => {
    const found = await client.query<{ id: string; source_id: string }>(
      `SELECT id, source_id FROM investigations WHERE deleted_at IS NOT NULL AND purge_after <= now() ORDER BY purge_after, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    const [held] = found.rows;
    if (held === undefined) return false;
    await beforeDelete({ id: held.id, sourceId: held.source_id });
    await client.query(`DELETE FROM investigations WHERE id = $1 AND deleted_at IS NOT NULL AND purge_after <= now()`, [held.id]);
    return true;
  });
}

export async function purgeExpiredInvestigations(pool: pg.Pool, beforeDelete: (purged: PurgedInvestigation) => Promise<void>): Promise<number> {
  let purged = 0;
  for (;;) {
    for (let inPass = 0; inPass < PURGE_PASS_SIZE; inPass += 1) {
      if (!(await purgeOne(pool, beforeDelete))) return purged;
      purged += 1;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export async function readLibrary<T>(pool: pg.Pool, read: (reader: LibraryReader) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const answer = await read({
      listInvestigationSourceIds: (ownerId) => listInvestigationSourceIds(client, ownerId),
      listInvestigations: (query) => listInvestigations(client, query),
      countMatching: (query) => countMatching(client, query),
      countInvestigations: (query) => countInvestigations(client, query),
      countNamedViews: (query) => countNamedViews(client, query),
      listDeletedInvestigationSourceIds: (ownerId) => listDeletedInvestigationSourceIds(client, ownerId),
      listDeletedInvestigations: (query) => listDeletedInvestigations(client, query),
      countDeletedMatching: (query) => countDeletedMatching(client, query),
    });
    await client.query('COMMIT');
    return answer;
  } catch (error) {
    // The error that stopped the read is the one to report; a connection whose rollback failed may still hold the transaction, so it is destroyed and not returned to the pool.
    await client.query('ROLLBACK').catch(() => {
      discard = true;
    });
    throw error;
  } finally {
    client.release(discard);
  }
}
