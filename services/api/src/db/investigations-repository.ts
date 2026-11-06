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

export interface InvestigationStore {
  /** Writes the investigation and its draft, or, when the input has a case reference and the owner already has an open investigation for it, returns that one and writes nothing. The two are decided in one step, so two calls at once make one investigation. */
  createInvestigation(input: NewInvestigation): Promise<CreatedInvestigation>;
  findReusableInvestigation(query: ReusableQuery): Promise<InvestigationRow | undefined>;
  readInvestigation(id: string, ownerId: string): Promise<StoredInvestigation | undefined>;
  listInvestigationSourceIds(ownerId: string): Promise<string[]>;
  listInvestigations(query: ListQuery): Promise<ListedInvestigation[]>;
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
}

export async function readInvestigation(db: pg.Pool, id: string, ownerId: string): Promise<StoredInvestigation | undefined> {
  const result = await db.query<StoredRecord>(
    `SELECT ${QUALIFIED_COLUMNS}, v.id AS draft_id, v.version AS draft_version, v.layout, v.query_context
     FROM investigations i JOIN saved_views v ON v.investigation_id = i.id AND v.kind = 'draft' AND v.created_by = i.owner_id
     WHERE i.id = $1 AND i.owner_id = $2 AND i.deleted_at IS NULL`,
    [id, ownerId],
  );
  const [record] = result.rows;
  if (record === undefined) return undefined;
  return { investigation: rowOf(record), draft: { id: record.draft_id, version: record.draft_version, layout: record.layout, queryContext: record.query_context } };
}

interface ListedRecord extends InvestigationRecord {
  readonly source_alias: string;
  readonly saved_at: Date | null;
}

export async function listInvestigationSourceIds(db: pg.Pool, ownerId: string): Promise<string[]> {
  const result = await db.query<{ source_id: string }>(`SELECT DISTINCT source_id FROM investigations WHERE owner_id = $1 AND status = 'open' AND deleted_at IS NULL`, [ownerId]);
  return result.rows.map((record) => record.source_id);
}

export async function listInvestigations(db: pg.Pool, query: ListQuery): Promise<ListedInvestigation[]> {
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
