import { layoutDocumentSchema, queryContextDocumentSchema, type InvestigationSave, type LayoutDocument, type QueryContextDocument } from '@neburyx/contracts';
import type pg from 'pg';

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
  readonly version: number;
}

export interface DraftRow {
  readonly id: string;
  readonly version: number;
  readonly layout: unknown;
  readonly queryContext: unknown;
  readonly notes: string | null;
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
export type DraftWriteResult = { readonly outcome: 'saved' | 'unchanged'; readonly version: number; readonly save: InvestigationSave } | { readonly outcome: 'conflict' } | { readonly outcome: 'not-found' };

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
}

export interface ListedInvestigation extends InvestigationRow {
  readonly sourceAlias: string;
  readonly save: InvestigationSave;
}

export interface ListQuery {
  readonly ownerId: string;
  readonly sourceIds: readonly string[];
  readonly limit: number;
}

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
  countInvestigations(query: CountQuery): Promise<InvestigationCounts>;
  countNamedViews(query: CountQuery): Promise<NamedViewCounts>;
}

export interface InvestigationStore {
  /** Writes the investigation and its draft, or, when the input has a case reference and the owner already has an open investigation for it, returns that one and writes nothing. The two are decided in one step, so two calls at once make one investigation. */
  createInvestigation(input: NewInvestigation): Promise<CreatedInvestigation>;
  findReusableInvestigation(query: ReusableQuery): Promise<InvestigationRow | undefined>;
  readInvestigation(id: string, ownerId: string): Promise<StoredInvestigation | undefined>;
  /** Replaces the owner's draft when `expectedVersion` is its version, in one transaction under a lock on the draft row, so two writes with one version make one winner. `last_edited_at` of the investigation moves only when the content changed. */
  saveDraft(write: DraftWrite): Promise<DraftWriteResult>;
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
  readonly version: number;
}

const COLUMNS = `id, source_id, source_identity_hash, owner_id, title, case_ref, starting_entity_type, starting_stable_id, status, created_at, last_edited_at, version`;
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
}

export async function readInvestigation(db: pg.Pool, id: string, ownerId: string): Promise<StoredInvestigation | undefined> {
  const result = await db.query<StoredRecord>(
    `SELECT ${QUALIFIED_COLUMNS}, v.id AS draft_id, v.version AS draft_version, v.layout, v.query_context, v.notes
     FROM investigations i JOIN saved_views v ON v.investigation_id = i.id AND v.kind = 'draft' AND v.created_by = i.owner_id
     WHERE i.id = $1 AND i.owner_id = $2 AND i.deleted_at IS NULL`,
    [id, ownerId],
  );
  const [record] = result.rows;
  if (record === undefined) return undefined;
  return { investigation: rowOf(record), draft: { id: record.draft_id, version: record.draft_version, layout: record.layout, queryContext: record.query_context, notes: record.notes } };
}

interface DraftRecord {
  readonly id: string;
  readonly version: number;
  readonly content_hash: string;
  readonly notes: string | null;
  readonly ai_notes: unknown;
  readonly saved_at: Date | null;
}

const DRAFT_STATE = `SELECT draft.id, draft.version, draft.content_hash, draft.notes, draft.ai_notes, CASE WHEN named.content_hash = draft.content_hash THEN named.created_at END AS saved_at
     FROM saved_views draft
     JOIN investigations i ON i.id = draft.investigation_id AND i.owner_id = draft.created_by
     LEFT JOIN saved_views named ON named.id = draft.based_on_view_id AND named.kind = 'named'
     WHERE i.id = $1 AND i.owner_id = $2 AND i.deleted_at IS NULL AND draft.kind = 'draft'`;

const saveOf = (savedAt: Date | null): InvestigationSave => (savedAt === null ? { state: 'unsaved', savedAt: null } : { state: 'saved', savedAt: savedAt.toISOString() });

export async function saveDraft(pool: pg.Pool, write: DraftWrite): Promise<DraftWriteResult> {
  const layout = layoutDocumentSchema.parse(write.layout);
  const queryContext = queryContextDocumentSchema.parse(write.queryContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<DraftRecord>(`${DRAFT_STATE} FOR UPDATE OF draft`, [write.investigationId, write.ownerId]);
    const [held] = found.rows;
    if (held === undefined) {
      await client.query('ROLLBACK');
      return { outcome: 'not-found' };
    }
    if (held.version !== write.expectedVersion) {
      await client.query('ROLLBACK');
      return { outcome: 'conflict' };
    }
    const contentHash = write.contentHashOf({ aiNotes: held.ai_notes });
    if (contentHash === held.content_hash) {
      await client.query('COMMIT');
      return { outcome: 'unchanged', version: held.version, save: saveOf(held.saved_at) };
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

interface ListedRecord extends InvestigationRecord {
  readonly source_alias: string;
  readonly saved_at: Date | null;
}

export async function listInvestigationSourceIds(db: pg.Pool | pg.PoolClient, ownerId: string): Promise<string[]> {
  const result = await db.query<{ source_id: string }>(`SELECT DISTINCT source_id FROM investigations WHERE owner_id = $1 AND status = 'open' AND deleted_at IS NULL`, [ownerId]);
  return result.rows.map((record) => record.source_id);
}

export async function listInvestigations(db: pg.Pool | pg.PoolClient, query: ListQuery): Promise<ListedInvestigation[]> {
  const result = await db.query<ListedRecord>(
    `SELECT ${QUALIFIED_COLUMNS}, s.alias AS source_alias, CASE WHEN named.content_hash = draft.content_hash THEN named.created_at END AS saved_at
     FROM investigations i
     JOIN sources s ON s.id = i.source_id
     LEFT JOIN saved_views draft ON draft.investigation_id = i.id AND draft.kind = 'draft' AND draft.created_by = i.owner_id
     LEFT JOIN saved_views named ON named.id = draft.based_on_view_id AND named.kind = 'named'
     WHERE i.owner_id = $1 AND i.source_id = ANY($2::text[]) AND i.status = 'open' AND i.deleted_at IS NULL
     ORDER BY i.last_edited_at DESC, i.id DESC
     LIMIT $3`,
    [query.ownerId, [...query.sourceIds], query.limit],
  );
  return result.rows.map((record) => ({ ...rowOf(record), sourceAlias: record.source_alias, save: record.saved_at === null ? { state: 'unsaved', savedAt: null } : { state: 'saved', savedAt: record.saved_at.toISOString() } }));
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
     WHERE v.kind = 'named' AND i.owner_id = $1 AND i.source_id = ANY($2::text[]) AND i.status = 'open' AND i.deleted_at IS NULL`,
    [query.ownerId, [...query.sourceIds]],
  );
  const [row] = result.rows;
  if (row === undefined) throw new Error('the named view counts were not returned');
  return { views: row.views, lastEditedAt: row.last_edited_at === null ? null : row.last_edited_at.toISOString() };
}

export async function readLibrary<T>(pool: pg.Pool, read: (reader: LibraryReader) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const answer = await read({
      listInvestigationSourceIds: (ownerId) => listInvestigationSourceIds(client, ownerId),
      listInvestigations: (query) => listInvestigations(client, query),
      countInvestigations: (query) => countInvestigations(client, query),
      countNamedViews: (query) => countNamedViews(client, query),
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
