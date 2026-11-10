import type pg from 'pg';
import type { ViewPosition } from './views-repository.js';

export interface OwnedViewListQuery {
  readonly ownerId: string;
  readonly sourceIds: readonly string[];
  readonly limit: number;
  readonly after: ViewPosition | undefined;
}

export interface OwnedViewRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly createdKey: string;
  readonly version: number;
  readonly savedByName: string;
  readonly investigation: {
    readonly id: string;
    readonly title: string;
    readonly sourceId: string;
    readonly sourceAlias: string;
    readonly status: 'open' | 'closed' | 'archived';
    readonly startingEntityType: string | null;
    readonly startingStableId: string | null;
  };
}

export interface OwnedViewList {
  /** At most `limit` views, newest first by (time, id). */
  readonly items: readonly OwnedViewRow[];
  readonly next: ViewPosition | undefined;
  readonly count: number;
}

export interface OwnedViewStore {
  /** The named views of the owner's undeleted investigations on the given sources, with the exact number of them, read at one snapshot. */
  listOwnedViews(query: OwnedViewListQuery): Promise<OwnedViewList>;
}

interface OwnedViewRecord {
  readonly id: string;
  readonly name: string;
  readonly created_at: Date;
  readonly created_key: string;
  readonly version: number;
  readonly display_name: string;
  readonly investigation_id: string;
  readonly title: string;
  readonly source_id: string;
  readonly source_alias: string;
  readonly status: 'open' | 'closed' | 'archived';
  readonly starting_entity_type: string | null;
  readonly starting_stable_id: string | null;
}

const CREATED_KEY = `to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function listOwnedViews(pool: pg.Pool, query: OwnedViewListQuery): Promise<OwnedViewList> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const after = query.after;
    const page = await client.query<OwnedViewRecord>(
      `SELECT v.id, v.name, v.created_at, ${CREATED_KEY} AS created_key, v.version, u.display_name,
              i.id AS investigation_id, i.title, i.source_id, s.alias AS source_alias, i.status, i.starting_entity_type, i.starting_stable_id
       FROM saved_views v
       JOIN investigations i ON i.id = v.investigation_id
       JOIN sources s ON s.id = i.source_id
       JOIN users u ON u.id = v.created_by
       WHERE v.kind = 'named' AND v.deleted_at IS NULL AND i.owner_id = $1 AND i.source_id = ANY($2::text[]) AND i.deleted_at IS NULL
         AND ($3::text IS NULL OR (v.created_at, v.id) < ($3::timestamptz, $4::uuid))
       ORDER BY v.created_at DESC, v.id DESC
       LIMIT $5`,
      [query.ownerId, [...query.sourceIds], after?.createdKey ?? null, after?.id ?? null, query.limit + 1],
    );
    const counted = await client.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM saved_views v JOIN investigations i ON i.id = v.investigation_id
       WHERE v.kind = 'named' AND v.deleted_at IS NULL AND i.owner_id = $1 AND i.source_id = ANY($2::text[]) AND i.deleted_at IS NULL`,
      [query.ownerId, [...query.sourceIds]],
    );
    await client.query('COMMIT');
    const shown = page.rows.slice(0, query.limit);
    const last = shown.at(-1);
    return {
      items: shown.map((record) => ({
        id: record.id,
        name: record.name,
        createdAt: record.created_at.toISOString(),
        createdKey: record.created_key,
        version: record.version,
        savedByName: record.display_name,
        investigation: { id: record.investigation_id, title: record.title, sourceId: record.source_id, sourceAlias: record.source_alias, status: record.status, startingEntityType: record.starting_entity_type, startingStableId: record.starting_stable_id },
      })),
      next: page.rows.length > query.limit && last !== undefined ? { createdKey: last.created_key, id: last.id } : undefined,
      count: counted.rows[0]?.total ?? 0,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
