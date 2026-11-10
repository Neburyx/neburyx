import { layoutDocumentSchema, queryContextDocumentSchema, type LayoutDocument, type NamedView, type QueryContextDocument } from '@neburyx/contracts';
import type pg from 'pg';
import { readOnlyStatusOf, type ReadOnlyStatus } from '../investigations/read-only.js';

/** What a view save writes. `contentHashOf` is given the draft as it is stored, with the `ai_notes` it holds, and returns the hash of the draft once it carries the new notes. */
export interface ViewSave {
  readonly investigationId: string;
  readonly ownerId: string;
  readonly viewId: string;
  readonly expectedDraftVersion: number;
  readonly name: string;
  readonly notes: string | null;
  readonly title: { readonly value: string; readonly expectedInvestigationVersion: number } | undefined;
  readonly contentHashOf: (held: { readonly layout: LayoutDocument; readonly queryContext: QueryContextDocument; readonly aiNotes: unknown }) => string;
}

export type ViewSaveResult =
  | {
      readonly outcome: 'saved';
      readonly view: NamedView;
      readonly draft: { readonly version: number; readonly notes: string | null; readonly basedOnViewId: string };
      readonly save: { readonly state: 'saved'; readonly savedAt: string };
      readonly investigation: { readonly title: string; readonly version: number } | undefined;
    }
  | { readonly outcome: 'draft-conflict' }
  | { readonly outcome: 'investigation-conflict' }
  | { readonly outcome: 'read-only'; readonly status: ReadOnlyStatus }
  | { readonly outcome: 'not-found' };

interface HeldDraft {
  readonly investigation_status: 'open' | 'closed' | 'archived';
  readonly id: string;
  readonly version: number;
  readonly layout: unknown;
  readonly query_context: unknown;
  readonly ai_notes: unknown;
  readonly mapping_hash: string;
  readonly node_count: number;
  readonly edge_count: number;
  readonly counts_policy_version: string;
}

interface InsertedView {
  readonly id: string;
  readonly name: string;
  readonly notes: string | null;
  readonly created_at: Date;
  readonly version: number;
  readonly display_name: string;
}

const LOCK_DRAFT = `SELECT i.status AS investigation_status, draft.id, draft.version, draft.layout, draft.query_context, draft.ai_notes, draft.mapping_hash, draft.node_count, draft.edge_count, draft.counts_policy_version
     FROM saved_views draft
     JOIN investigations i ON i.id = draft.investigation_id AND i.owner_id = draft.created_by
     WHERE i.id = $1 AND i.owner_id = $2 AND i.deleted_at IS NULL AND draft.kind = 'draft'
     FOR UPDATE OF i, draft`;

/** Where a page of views starts: after the view made at `createdKey`, microsecond text as the database holds it, with this `id`. */
export interface ViewPosition {
  readonly createdKey: string;
  readonly id: string;
}

export interface ViewListQuery {
  readonly investigationId: string;
  readonly ownerId: string;
  readonly limit: number;
  readonly after: ViewPosition | undefined;
}

export type ViewListResult =
  | {
      readonly outcome: 'listed';
      /** At most `limit` views, newest first. */
      readonly items: readonly NamedView[];
      /** Where the next page starts, when there is one. */
      readonly next: ViewPosition | undefined;
      readonly count: number;
      readonly draft: { readonly basedOnViewId: string | null; readonly updatedAt: string };
    }
  | { readonly outcome: 'not-found' };

export interface ViewRename {
  readonly investigationId: string;
  readonly viewId: string;
  readonly ownerId: string;
  readonly expectedVersion: number;
  readonly name: string;
}

export type ViewRenameResult = { readonly outcome: 'renamed'; readonly view: NamedView } | { readonly outcome: 'conflict' } | { readonly outcome: 'read-only'; readonly status: ReadOnlyStatus } | { readonly outcome: 'not-found' };

export interface ViewRestore {
  readonly investigationId: string;
  readonly viewId: string;
  readonly ownerId: string;
  readonly expectedDraftVersion: number;
}

/** The draft as the restore wrote it, read in the same transaction; `savedAt` is when the view was made, which the draft now equals. */
export type ViewRestoreResult =
  | { readonly outcome: 'restored'; readonly savedAt: string; readonly draft: { readonly version: number; readonly layout: unknown; readonly queryContext: unknown; readonly notes: string | null; readonly basedOnViewId: string } }
  | { readonly outcome: 'draft-conflict' }
  | { readonly outcome: 'read-only'; readonly status: ReadOnlyStatus }
  | { readonly outcome: 'not-found' };

export interface ViewStore {
  saveNamedView(save: ViewSave): Promise<ViewSaveResult>;
  /** The investigation's named views, newest first by (time, id), with the exact number of them and what the draft is based on, all read at one snapshot. */
  listNamedViews(query: ViewListQuery): Promise<ViewListResult>;
  /** Changes the name of a named view when `expectedVersion` is its version, and nothing else of it or of the investigation. */
  renameNamedView(rename: ViewRename): Promise<ViewRenameResult>;
  /** Copies a named view over the owner's draft when `expectedDraftVersion` is the draft's version, in one transaction under a lock on the draft row. The view is not touched; `last_edited_at` moves only when the draft's content changed. */
  restoreNamedView(restore: ViewRestore): Promise<ViewRestoreResult>;
}

/** Writes the named view, points the draft at it and, when asked, changes the title, in one transaction under a lock on the draft row, so two saves with one version make one winner and a refused save leaves nothing behind. */
export async function saveNamedView(pool: pg.Pool, save: ViewSave): Promise<ViewSaveResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<HeldDraft>(LOCK_DRAFT, [save.investigationId, save.ownerId]);
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
    if (held.version !== save.expectedDraftVersion) {
      await client.query('ROLLBACK');
      return { outcome: 'draft-conflict' };
    }
    const investigation = await changeTitle(client, save);
    if (investigation === 'conflict') {
      await client.query('ROLLBACK');
      return { outcome: 'investigation-conflict' };
    }
    const contentHash = save.contentHashOf({ layout: layoutDocumentSchema.parse(held.layout), queryContext: queryContextDocumentSchema.parse(held.query_context), aiNotes: held.ai_notes });
    const inserted = await client.query<InsertedView>(
      `WITH inserted AS (
         INSERT INTO saved_views (id, investigation_id, kind, name, notes, ai_notes, layout, query_context, mapping_hash, content_hash, node_count, edge_count, counts_policy_version, created_by)
         VALUES ($1, $2, 'named', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id, name, notes, created_at, version, created_by)
       SELECT inserted.id, inserted.name, inserted.notes, inserted.created_at, inserted.version, u.display_name FROM inserted JOIN users u ON u.id = inserted.created_by`,
      [save.viewId, save.investigationId, save.name, save.notes, held.ai_notes === null ? null : JSON.stringify(held.ai_notes), JSON.stringify(held.layout), JSON.stringify(held.query_context), held.mapping_hash, contentHash, held.node_count, held.edge_count, held.counts_policy_version, save.ownerId],
    );
    const [view] = inserted.rows;
    if (view === undefined) throw new Error('the view was not returned after it was written');
    const updated = await client.query<{ version: number }>(
      `UPDATE saved_views SET notes = $2, content_hash = $3, based_on_view_id = $4, version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
      [held.id, save.notes, contentHash, save.viewId],
    );
    await client.query(`UPDATE investigations SET last_edited_at = now() WHERE id = $1`, [save.investigationId]);
    await client.query('COMMIT');
    const [draft] = updated.rows;
    if (draft === undefined) throw new Error('the draft was not returned after its write');
    return {
      outcome: 'saved',
      view: { id: view.id, name: view.name, notes: view.notes, savedBy: { name: view.display_name }, createdAt: view.created_at.toISOString(), version: view.version },
      draft: { version: draft.version, notes: save.notes, basedOnViewId: save.viewId },
      save: { state: 'saved', savedAt: view.created_at.toISOString() },
      investigation,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function changeTitle(client: pg.PoolClient, save: ViewSave): Promise<{ readonly title: string; readonly version: number } | undefined | 'conflict'> {
  if (save.title === undefined) return undefined;
  const result = await client.query<{ title: string; version: number }>(
    `UPDATE investigations SET title = $2, version = version + 1 WHERE id = $1 AND version = $3 RETURNING title, version`,
    [save.investigationId, save.title.value, save.title.expectedInvestigationVersion],
  );
  const [changed] = result.rows;
  return changed === undefined ? 'conflict' : changed;
}

interface ListedView {
  readonly id: string;
  readonly name: string;
  readonly notes: string | null;
  readonly created_at: Date;
  readonly created_key: string;
  readonly version: number;
  readonly display_name: string;
}

const CREATED_KEY = `to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const viewOf = (row: ListedView): NamedView => ({ id: row.id, name: row.name, notes: row.notes, savedBy: { name: row.display_name }, createdAt: row.created_at.toISOString(), version: row.version });

export async function listNamedViews(pool: pg.Pool, query: ViewListQuery): Promise<ViewListResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const draft = await client.query<{ based_on_view_id: string | null; updated_at: Date }>(
      `SELECT named.id AS based_on_view_id, draft.updated_at
       FROM saved_views draft
       JOIN investigations i ON i.id = draft.investigation_id AND i.owner_id = draft.created_by
       LEFT JOIN saved_views named ON named.id = draft.based_on_view_id AND named.kind = 'named'
       WHERE i.id = $1 AND i.owner_id = $2 AND i.deleted_at IS NULL AND draft.kind = 'draft'`,
      [query.investigationId, query.ownerId],
    );
    const [held] = draft.rows;
    if (held === undefined) {
      await client.query('ROLLBACK');
      return { outcome: 'not-found' };
    }
    const after = query.after;
    const page = await client.query<ListedView>(
      `SELECT v.id, v.name, v.notes, v.created_at, ${CREATED_KEY} AS created_key, v.version, u.display_name
       FROM saved_views v JOIN users u ON u.id = v.created_by
       WHERE v.investigation_id = $1 AND v.kind = 'named' AND ($2::text IS NULL OR (v.created_at, v.id) < ($2::timestamptz, $3::uuid))
       ORDER BY v.created_at DESC, v.id DESC
       LIMIT $4`,
      [query.investigationId, after?.createdKey ?? null, after?.id ?? null, query.limit + 1],
    );
    const counted = await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM saved_views WHERE investigation_id = $1 AND kind = 'named'`, [query.investigationId]);
    await client.query('COMMIT');
    const shown = page.rows.slice(0, query.limit);
    const last = shown.at(-1);
    return {
      outcome: 'listed',
      items: shown.map(viewOf),
      next: page.rows.length > query.limit && last !== undefined ? { createdKey: last.created_key, id: last.id } : undefined,
      count: counted.rows[0]?.total ?? 0,
      draft: { basedOnViewId: held.based_on_view_id, updatedAt: held.updated_at.toISOString() },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function renameNamedView(pool: pg.Pool, rename: ViewRename): Promise<ViewRenameResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<{ version: number; investigation_status: 'open' | 'closed' | 'archived' }>(
      `SELECT v.version, i.status AS investigation_status FROM saved_views v JOIN investigations i ON i.id = v.investigation_id
       WHERE v.id = $1 AND v.investigation_id = $2 AND v.kind = 'named' AND i.owner_id = $3 AND i.deleted_at IS NULL
       FOR UPDATE OF v, i`,
      [rename.viewId, rename.investigationId, rename.ownerId],
    );
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
    if (held.version !== rename.expectedVersion) {
      await client.query('ROLLBACK');
      return { outcome: 'conflict' };
    }
    const updated = await client.query<ListedView>(
      `WITH changed AS (UPDATE saved_views v SET name = $2, version = version + 1, updated_at = now() WHERE v.id = $1 RETURNING v.id, v.name, v.notes, v.created_at, v.version, v.created_by)
       SELECT v.id, v.name, v.notes, v.created_at, '' AS created_key, v.version, u.display_name FROM changed v JOIN users u ON u.id = v.created_by`,
      [rename.viewId, rename.name],
    );
    await client.query('COMMIT');
    const [view] = updated.rows;
    if (view === undefined) throw new Error('the view was not returned after its rename');
    return { outcome: 'renamed', view: viewOf(view) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface RestoredFrom {
  readonly id: string;
  readonly content_hash: string;
  readonly created_at: Date;
}

export async function restoreNamedView(pool: pg.Pool, restore: ViewRestore): Promise<ViewRestoreResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const draft = await client.query<{ id: string; version: number; content_hash: string; investigation_status: 'open' | 'closed' | 'archived' }>(
      `SELECT i.status AS investigation_status, draft.id, draft.version, draft.content_hash
       FROM saved_views draft JOIN investigations i ON i.id = draft.investigation_id AND i.owner_id = draft.created_by
       WHERE i.id = $1 AND i.owner_id = $2 AND i.deleted_at IS NULL AND draft.kind = 'draft'
       FOR UPDATE OF i, draft`,
      [restore.investigationId, restore.ownerId],
    );
    const [held] = draft.rows;
    const view = await client.query<RestoredFrom>(`SELECT id, content_hash, created_at FROM saved_views WHERE id = $1 AND investigation_id = $2 AND kind = 'named'`, [restore.viewId, restore.investigationId]);
    const [from] = view.rows;
    if (held === undefined || from === undefined) {
      await client.query('ROLLBACK');
      return { outcome: 'not-found' };
    }
    const readOnly = readOnlyStatusOf(held.investigation_status);
    if (readOnly !== undefined) {
      await client.query('ROLLBACK');
      return { outcome: 'read-only', status: readOnly };
    }
    if (held.version !== restore.expectedDraftVersion) {
      await client.query('ROLLBACK');
      return { outcome: 'draft-conflict' };
    }
    const written = await client.query<{ version: number; layout: unknown; query_context: unknown; notes: string | null }>(
      `UPDATE saved_views AS draft SET layout = v.layout, query_context = v.query_context, notes = v.notes, ai_notes = v.ai_notes, mapping_hash = v.mapping_hash, node_count = v.node_count, edge_count = v.edge_count,
         counts_policy_version = v.counts_policy_version, content_hash = v.content_hash, based_on_view_id = v.id, version = draft.version + 1, updated_at = now()
       FROM saved_views v WHERE draft.id = $1 AND v.id = $2
       RETURNING draft.version, draft.layout, draft.query_context, draft.notes`,
      [held.id, from.id],
    );
    const [draftNow] = written.rows;
    if (draftNow === undefined) throw new Error('the draft was not returned after its restore');
    if (held.content_hash !== from.content_hash) await client.query(`UPDATE investigations SET last_edited_at = now() WHERE id = $1`, [restore.investigationId]);
    await client.query('COMMIT');
    return { outcome: 'restored', savedAt: from.created_at.toISOString(), draft: { version: draftNow.version, layout: draftNow.layout, queryContext: draftNow.query_context, notes: draftNow.notes, basedOnViewId: from.id } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
