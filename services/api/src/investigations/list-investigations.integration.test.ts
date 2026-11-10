import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { investigationListResponseSchema, ownedViewListResponseSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createAppStore, type AppStore } from '../app-store.js';
import { uuidv7 } from '../identity/uuid.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Seams } from '../seams/seams.js';
import { runCli } from '../testing/cli.js';
import { rows } from '../testing/database.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { testSourceGate } from '../testing/source-gate.js';
import { webRoot } from '../testing/start-api.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { initialDraftDocuments } from './draft.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const entities = [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }, { type: 'gizmo', label: 'Gizmo', stable_id: 'gizmoId' }];
const relationships = [{ type: 'LINKS', from: 'widget', to: 'gizmo' }];
const sources = ['demo', 'other', 'secret'].map((id) => baseSource({ id, uri: `neo4j+s://${id}.example.test:7687`, entities, relationships }));
const withRetired = parseMapping(fileOf(...sources, baseSource({ id: 'retired', uri: 'neo4j+s://retired.example.test:7687', entities, relationships })), 'neburyx.yaml');
const mapping = parseMapping(fileOf(...sources), 'neburyx.yaml');
const modelOf = (id: string) => withRetired.sources.find((source) => source.id === id) ?? (() => { throw new Error(`no source ${id}`); })();

let postgres: TestPostgres;
const stores: AppStore[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(stores.map((store) => store.close()));
  await postgres.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

async function running(refused: readonly string[] = ['secret'], hooks: { afterDiscovery?: () => Promise<unknown>; betweenReads?: () => Promise<unknown>; connectionTimeoutMs?: number } = {}) {
  const database: TestDatabase = await postgres.newDatabase();
  expect((await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done).code).toBe(0);
  const opened = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED, ...(hooks.connectionTimeoutMs === undefined ? {} : { connectionTimeoutMs: hooks.connectionTimeoutMs }) });
  let closing: Promise<void> | undefined;
  // the hook runs after the rows are read and before the counts, inside the snapshot of the list
  const store: AppStore = {
    ...opened,
    readLibrary: (read) => opened.readLibrary((reader) => read({ ...reader, listInvestigations: async (query) => { const listed = await reader.listInvestigations(query); await hooks.betweenReads?.(); return listed; } })),
    close: () => (closing ??= opened.close()),
  };
  stores.push(store);
  await store.initialize();
  await store.syncSources(withRetired.sources);
  await store.syncSources(mapping.sources);
  const seams: Seams = { ...communitySeams(), policy: { authorizeSource: async ({ sourceId }) => {
      await hooks.afterDiscovery?.();
      return refused.includes(sourceId) ? { allowed: false, reason: 'not permitted' } : { allowed: true };
    } } };
  const executor = new TestExecutor(withOnlineIndexes(mapping.sources[0] ?? (() => { throw new Error('the mapping has no source'); })(), () => Promise.resolve(entityRows(plainNode(['Widget'], { widgetId: 'W-1' })))));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, seams, gate: testSourceGate(mapping, { executor, seams }).gate });
  const [owner] = await rows(database.ownerUrl, `SELECT id FROM users WHERE issuer = 'local'`);
  const ownerId = String(owner?.['id']);
  const list = async (query = '') => {
    const response = await app.inject({ method: 'GET', url: `/v1/investigations${query}` });
    return { status: response.statusCode, body: investigationListResponseSchema.parse(response.json()) };
  };
  async function add(sourceId: string, editedAt: string, overrides: { owner?: string; id?: string; status?: string; deleted?: boolean; model?: string } = {}): Promise<string> {
    const id = overrides.id ?? uuidv7();
    const documents = initialDraftDocuments({ entityType: 'widget', stableId: id.slice(-6) });
    await store.createInvestigation({
      id,
      sourceId,
      sourceIdentityHash: identityHashOf(modelOf(overrides.model ?? sourceId)),
      ownerId: overrides.owner ?? ownerId,
      title: `Widget ${id.slice(-6)}`,
      caseRef: null,
      startingEntityType: 'widget',
      startingStableId: id.slice(-6),
      draft: { id: uuidv7(), ...documents, mappingHash: 'm', contentHash: 'c1', nodeCount: 1, edgeCount: 0, countsPolicyVersion: 'none' },
    });
    await rows(database.ownerUrl, `UPDATE investigations SET last_edited_at = $2, created_at = $3, status = $4, deleted_at = $5 WHERE id = $1`, [id, editedAt, '2026-11-05T09:00:00Z', overrides.status ?? 'open', overrides.deleted === true ? '2026-11-05T11:00:00Z' : null]);
    return id;
  }
  return { database, app, store, ownerId, list, add };
}

const at = (minute: number): string => new Date(Date.UTC(2026, 10, 5, 12, minute)).toISOString();

describe('the list of investigations against Postgres', () => {
  it('lists the owner\'s open investigations newest first, with the larger id first between equal times, and nobody else\'s', async () => {
    const { database, app, add, list } = await running();
    const [other] = await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'issuer', 'second', 'Second') RETURNING id`, [uuidv7()]);
    const older = await add('demo', at(1));
    const tieLow = await add('other', at(5), { id: '0192f000-0000-7000-8000-000000000a01' });
    const tieHigh = await add('demo', at(5), { id: '0192f000-0000-7000-8000-000000000a02' });
    const newest = await add('other', at(9));
    await add('demo', at(7), { owner: String(other?.['id']) });
    const answer = await list('?limit=5&sort=lastEdited');
    expect(answer.status).toBe(200);
    expect(investigationListResponseSchema.safeParse(answer.body).success).toBe(true);
    expect(answer.body.items.map((item) => item.id)).toEqual([newest, tieHigh, tieLow, older]);
    expect(answer.body.items.map((item) => item.sourceId)).toEqual(['other', 'demo', 'other', 'demo']);
    expect(answer.body.nextCursor).toBeNull();
    expect(await list()).toEqual(answer);
    await app.close();
  });

  it('never lists a closed, archived or deleted investigation', async () => {
    const { app, add, list } = await running();
    const wanted = await add('demo', at(1));
    await add('demo', at(2), { status: 'closed' });
    await add('demo', at(3), { status: 'archived' });
    await add('demo', at(4), { deleted: true });
    expect((await list()).body.items.map((item) => item.id)).toEqual([wanted]);
    await app.close();
  });

  it('cuts the list at the limit and says there is more only when an eligible investigation lies beyond it', async () => {
    const { app, add, list } = await running();
    for (const minute of [1, 2, 3, 4, 5]) await add('demo', at(minute));
    expect((await list('?limit=5')).body).toMatchObject({ nextCursor: null });
    await add('demo', at(6));
    const answer = await list('?limit=5');
    expect(answer.body.items).toHaveLength(5);
    expect(answer.body.nextCursor).not.toBeNull();
    expect((await list('?limit=25')).body.items).toHaveLength(6);
    await app.close();
  });

  it('reads the saved state from the draft: unsaved with no named view or a different content, saved with the time of the view when the content is the same', async () => {
    const { database, app, add, list } = await running();
    const plain = await add('demo', at(1));
    const stale = await add('demo', at(2));
    const saved = await add('demo', at(3));
    const nameView = async (investigationId: string, contentHash: string): Promise<string> => {
      const viewId = uuidv7();
      await rows(
        database.ownerUrl,
        `INSERT INTO saved_views (id, investigation_id, kind, name, layout, query_context, mapping_hash, content_hash, node_count, edge_count, counts_policy_version, created_by, created_at)
         SELECT $1, investigation_id, 'named', 'A view', layout, query_context, mapping_hash, $3, node_count, edge_count, counts_policy_version, created_by, '2026-11-05T12:30:00Z' FROM saved_views WHERE investigation_id = $2 AND kind = 'draft'`,
        [viewId, investigationId, contentHash],
      );
      await rows(database.ownerUrl, `UPDATE saved_views SET based_on_view_id = $1 WHERE investigation_id = $2 AND kind = 'draft'`, [viewId, investigationId]);
      return viewId;
    };
    await nameView(stale, 'c-other');
    await nameView(saved, 'c1');
    const byId = new Map((await list()).body.items.map((item) => [item.id, item.save]));
    expect(byId.get(plain)).toEqual({ state: 'unsaved', savedAt: null });
    expect(byId.get(stale)).toEqual({ state: 'unsaved', savedAt: null });
    expect(byId.get(saved)).toEqual({ state: 'saved', savedAt: '2026-11-05T12:30:00.000Z' });
    await app.close();
  });

  it('lists the rows of a source taken out of the configuration with the alias the product stored, and of a source whose database changed', async () => {
    const { database, app, add, list } = await running();
    await rows(database.ownerUrl, `UPDATE sources SET alias = 'Retired books' WHERE id = 'retired'`);
    const gone = await add('retired', at(3));
    const moved = await add('demo', at(2), { model: 'other' });
    const kept = await add('demo', at(1));
    const answer = await list();
    expect(answer.body.items.map((item) => [item.id, item.sourceState, item.sourceAlias])).toEqual([[gone, 'removed', 'Retired books'], [moved, 'repointed', 'demo'], [kept, 'available', 'demo']]);
    await app.close();
  });

  it('leaves out the rows of a source the policy refuses, however new, and lists the readable ones up to the limit', async () => {
    const { app, add, list } = await running(['secret']);
    const readable = [await add('demo', at(1)), await add('other', at(2)), await add('demo', at(3))];
    await add('secret', at(20));
    await add('secret', at(21));
    const answer = await list('?limit=3');
    expect(answer.body.items.map((item) => item.id)).toEqual([...readable].reverse());
    expect(answer.body.nextCursor).toBeNull();
    await add('demo', at(4));
    expect((await list('?limit=3')).body.nextCursor).not.toBeNull();
    await app.close();
  });
});

describe('the list of investigations under more concurrent calls than the pool has connections', () => {
  it('answers every call when the policy reads the store, none holding a connection while it waits for another', async () => {
    let held: AppStore | undefined;
    const { app, store, add } = await running(['secret'], { connectionTimeoutMs: 2_000, afterDiscovery: () => (held ?? (() => { throw new Error('the store is not set'); })()).hasActiveSource('demo') });
    held = store;
    await add('demo', at(1));
    await add('other', at(2));
    const answers = await Promise.all(Array.from({ length: 12 }, () => app.inject({ method: 'GET', url: '/v1/investigations' })));
    expect(answers.map((answer) => answer.statusCode)).toEqual(Array.from({ length: 12 }, () => 200));
    for (const answer of answers) expect(investigationListResponseSchema.parse(answer.json()).items).toHaveLength(2);
    await app.close();
  });
});

describe('the deleted list under more concurrent calls than the pool has connections', () => {
  it('answers every call when the policy reads the store, none holding a connection while it waits for another', async () => {
    let held: AppStore | undefined;
    const { app, store, add, database } = await running(['secret'], { connectionTimeoutMs: 2_000, afterDiscovery: () => (held ?? (() => { throw new Error('the store is not set'); })()).hasActiveSource('demo') });
    held = store;
    for (const [source, minute] of [['demo', 1], ['other', 2]] as const) {
      const id = await add(source, at(minute), { deleted: true });
      await rows(database.ownerUrl, `UPDATE investigations SET purge_after = now() + interval '30 days', deleted_by = owner_id WHERE id = $1`, [id]);
    }
    const answers = await Promise.all(Array.from({ length: 12 }, () => app.inject({ method: 'GET', url: '/v1/investigations?deleted=true' })));
    expect(answers.map((answer) => answer.statusCode)).toEqual(Array.from({ length: 12 }, () => 200));
    for (const answer of answers) expect(investigationListResponseSchema.parse(answer.json()).items).toHaveLength(2);
    await app.close();
  });
});

describe('the counts of the list against Postgres', () => {
  const counts = (investigations: number, sources: number) => ({ investigations: { value: investigations, quality: 'exact', scope: 'investigations' }, sources: { value: sources, quality: 'exact', scope: 'investigation-sources' }, savedViews: { count: { value: 0, quality: 'exact', scope: 'named-views' }, lastEditedAt: null } });

  it('counts every investigation the person may list and the sources they are on, whatever the limit', async () => {
    const { app, add, list } = await running();
    await add('demo', at(1));
    await add('demo', at(2));
    await add('other', at(3));
    const answer = await list('?limit=1');
    expect(answer.body.items).toHaveLength(1);
    expect(answer.body.counts).toEqual(counts(3, 2));
    expect((await list('?limit=25')).body.counts).toEqual(counts(3, 2));
    await app.close();
  });

  it('counts an investigation of a source taken out of the configuration, and its source', async () => {
    const { app, add, list } = await running();
    await add('demo', at(1));
    await add('retired', at(2));
    expect((await list()).body.counts).toEqual(counts(2, 2));
    await app.close();
  });

  it('counts nothing of a source the policy refuses', async () => {
    const { app, add, list } = await running(['secret']);
    await add('demo', at(1));
    await add('secret', at(2));
    await add('secret', at(3));
    const answer = await list();
    expect(answer.body.items).toHaveLength(1);
    expect(answer.body.counts).toEqual(counts(1, 1));
    await app.close();
  });

  it('counts no closed, archived, deleted or other person\'s investigation', async () => {
    const { database, app, add, list } = await running();
    const [other] = await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'issuer', 'second', 'Second') RETURNING id`, [uuidv7()]);
    await add('demo', at(1));
    await add('demo', at(2), { status: 'closed' });
    await add('other', at(3), { status: 'archived' });
    await add('other', at(4), { deleted: true });
    await add('other', at(5), { owner: String(other?.['id']) });
    expect((await list()).body.counts).toEqual(counts(1, 1));
    await app.close();
  });

  it('says zero and exact for a person with no investigation', async () => {
    const { app, list } = await running();
    expect((await list()).body.counts).toEqual(counts(0, 0));
    await app.close();
  });

  it('answers wholly as of the first read when an investigation is created between two of the reads, with the rows, the counts and the next cursor agreeing, and counts it at the next call', async () => {
    const hooks: { betweenReads?: () => Promise<unknown> } = {};
    const { app, add, list } = await running(['secret'], hooks);
    await add('demo', at(1));
    await add('demo', at(2));
    let created = false;
    hooks.betweenReads = async () => {
      if (created) return;
      created = true;
      await add('demo', at(9));
    };
    const during = await list('?limit=2');
    expect(created).toBe(true);
    expect(during.body.items).toHaveLength(2);
    expect(during.body.counts).toEqual(counts(2, 1));
    expect(during.body.nextCursor).toBeNull();
    const after = await list('?limit=2');
    expect(after.body.items).toHaveLength(2);
    expect(after.body.counts).toEqual(counts(3, 1));
    expect(after.body.nextCursor).not.toBeNull();
    await app.close();
  });
});

describe('the named view counts of the list against Postgres', () => {
  const zero = { count: { value: 0, quality: 'exact', scope: 'named-views' }, lastEditedAt: null };
  const views = (value: number, lastEditedAt: string) => ({ count: { value, quality: 'exact', scope: 'named-views' }, lastEditedAt });
  type Running = Awaited<ReturnType<typeof running>>;

  async function nameView(database: Running['database'], investigationId: string, updatedAt: string, contentHash?: string): Promise<string> {
    const viewId = uuidv7();
    await rows(
      database.ownerUrl,
      `INSERT INTO saved_views (id, investigation_id, kind, name, layout, query_context, mapping_hash, content_hash, node_count, edge_count, counts_policy_version, created_by, updated_at)
       SELECT $1, investigation_id, 'named', 'A view', layout, query_context, mapping_hash, COALESCE($4, content_hash), node_count, edge_count, counts_policy_version, created_by, $3 FROM saved_views WHERE investigation_id = $2 AND kind = 'draft'`,
      [viewId, investigationId, updatedAt, contentHash ?? null],
    );
    return viewId;
  }

  it('says zero and no time for investigations that hold no named view, whatever their drafts', async () => {
    const { app, add, list } = await running();
    await add('demo', at(1));
    await add('other', at(2));
    expect((await list()).body.counts.savedViews).toEqual(zero);
    await app.close();
  });

  it('counts every named view of the counted investigations, adds nothing to the investigation or source counts, and gives the newest time', async () => {
    const { database, app, add, list } = await running();
    const first = await add('demo', at(1));
    const second = await add('other', at(2));
    await nameView(database, first, '2026-11-05T12:10:00Z');
    await nameView(database, first, '2026-11-05T12:40:00Z');
    await nameView(database, second, '2026-11-05T12:20:00Z');
    const { counts } = (await list()).body;
    expect(counts.savedViews).toEqual(views(3, '2026-11-05T12:40:00.000Z'));
    expect([counts.investigations.value, counts.sources.value]).toEqual([2, 2]);
    await app.close();
  });

  it('counts a named view of an investigation on a source taken out of the configuration', async () => {
    const { database, app, add, list } = await running();
    const gone = await add('retired', at(1));
    await nameView(database, gone, '2026-11-05T12:15:00Z');
    expect((await list()).body.counts.savedViews).toEqual(views(1, '2026-11-05T12:15:00.000Z'));
    await app.close();
  });

  it('counts the named views of closed and archived investigations too, and no draft and no view of a deleted, other person\'s or refused-source investigation, and lets none of those set the time', async () => {
    const { database, app, add, list } = await running(['secret']);
    const [other] = await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'issuer', 'second', 'Second') RETURNING id`, [uuidv7()]);
    const counted = await add('demo', at(1));
    await nameView(database, counted, '2026-11-05T12:10:00Z');
    await nameView(database, await add('demo', at(2), { status: 'closed' }), '2026-11-05T12:20:00Z');
    await nameView(database, await add('demo', at(3), { status: 'archived' }), '2026-11-05T12:30:00Z');
    for (const hidden of [await add('demo', at(4), { deleted: true }), await add('demo', at(5), { owner: String(other?.['id']) }), await add('secret', at(6))]) {
      await nameView(database, hidden, '2026-11-05T13:00:00Z');
    }
    expect((await list()).body.counts.savedViews).toEqual(views(3, '2026-11-05T12:30:00.000Z'));
    await app.close();
  });

  it('answers wholly before or wholly after a named view that is saved between two of the reads, with the row\'s saved state and the count agreeing', async () => {
    const hooks: { betweenReads?: () => Promise<unknown> } = {};
    const { database, app, add, list } = await running(['secret'], hooks);
    const target = await add('demo', at(1));
    let saved = false;
    hooks.betweenReads = async () => {
      if (saved) return;
      saved = true;
      await rows(
        database.ownerUrl,
        `WITH made AS (
           INSERT INTO saved_views (id, investigation_id, kind, name, layout, query_context, mapping_hash, content_hash, node_count, edge_count, counts_policy_version, created_by, updated_at)
           SELECT $1, investigation_id, 'named', 'A view', layout, query_context, mapping_hash, content_hash, node_count, edge_count, counts_policy_version, created_by, '2026-11-05T12:30:00Z' FROM saved_views WHERE investigation_id = $2 AND kind = 'draft'
           RETURNING id
         )
         UPDATE saved_views SET based_on_view_id = (SELECT id FROM made) WHERE investigation_id = $2 AND kind = 'draft'`,
        [uuidv7(), target],
      );
    };
    const during = await list();
    expect(saved).toBe(true);
    expect(during.body.items[0]?.save.state).toBe('unsaved');
    expect(during.body.counts.savedViews).toEqual(zero);
    const after = await list();
    expect(after.body.items[0]?.save.state).toBe('saved');
    expect(after.body.counts.savedViews.count.value).toBe(1);
    await app.close();
  });
});

describe('paging, filters and counts of the list against Postgres', () => {
  type Running = Awaited<ReturnType<typeof running>>;
  const rename = (database: Running['database'], id: string, title: string, caseRef: string | null) => rows(database.ownerUrl, `UPDATE investigations SET title = $2, case_ref = $3 WHERE id = $1`, [id, title, caseRef]);

  it('pages 60 investigations 25 at a time and reaches each once, also when one is created or edited between two calls', async () => {
    const { database, app, add, list } = await running();
    const made: string[] = [];
    for (let minute = 0; minute < 60; minute += 1) made.push(await add(minute % 2 === 0 ? 'demo' : 'other', new Date(Date.UTC(2026, 10, 5, 12, 0, minute)).toISOString()));
    const first = await list();
    expect(first.body.items).toHaveLength(25);
    expect(first.body.matching.value).toBe(60);
    await add('demo', new Date(Date.UTC(2026, 10, 5, 13)).toISOString());
    await rows(database.ownerUrl, `UPDATE investigations SET last_edited_at = '2026-11-05T13:05:00Z' WHERE id = $1`, [made[3]]);
    const seen = first.body.items.map((item) => item.id);
    let cursor = first.body.nextCursor;
    while (cursor !== null) {
      const page = await list(`?cursor=${encodeURIComponent(cursor)}`);
      seen.push(...page.body.items.map((item) => item.id));
      cursor = page.body.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(58);
    expect(seen.slice(0, 25)).toEqual(first.body.items.map((item) => item.id));
    await app.close();
  });

  it('follows a page boundary through rows with equal edit times in id order', async () => {
    const { app, add, list } = await running();
    const ids: string[] = [];
    for (let index = 0; index < 7; index += 1) ids.push(await add('demo', at(5), { id: `0192f000-0000-7000-8000-000000000b0${index}` }));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof list>> = await list(`?limit=3${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      seen.push(...page.body.items.map((item) => item.id));
      cursor = page.body.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual([...ids].reverse());
    await app.close();
  });

  it('lists closed and archived rows of every readable source, narrows to a source, and answers empty for an unknown or refused one', async () => {
    const { app, add, list } = await running(['secret']);
    const open = await add('demo', at(1));
    const closed = await add('other', at(2), { status: 'closed' });
    const archived = await add('retired', at(3), { status: 'archived', model: 'retired' });
    await add('secret', at(4), { status: 'closed' });
    const ids = async (query: string) => (await list(query)).body.items.map((item) => item.id);
    expect(await ids('')).toEqual([open]);
    expect(await ids('?status=closed')).toEqual([closed]);
    expect(await ids('?status=archived')).toEqual([archived]);
    expect(await ids('?status=closed&source=other')).toEqual([closed]);
    expect(await ids('?status=closed&source=secret')).toEqual([]);
    expect((await list('?source=nowhere')).body.matching.value).toBe(0);
    await app.close();
  });

  it('finds a fragment of a title or a case reference whatever the case, and matches %, _ and a backslash as themselves', async () => {
    const { database, app, add, list } = await running();
    const percent = await add('demo', at(1));
    const underscore = await add('demo', at(2));
    const plain = await add('demo', at(3));
    const slash = await add('demo', at(4));
    const reference = await add('demo', at(5));
    await rename(database, percent, 'Rate 5%x', null);
    await rename(database, underscore, 'File a_b', null);
    await rename(database, plain, 'File axb', null);
    await rename(database, slash, 'Path c\\d', null);
    await rename(database, reference, 'Other', 'REF-2026-0042');
    const ids = async (query: string) => (await list(query)).body.items.map((item) => item.id);
    expect(await ids('?q=5%25')).toEqual([percent]);
    expect(await ids('?q=a_b')).toEqual([underscore]);
    expect(await ids('?q=c%5Cd')).toEqual([slash]);
    expect(await ids('?q=FILE')).toEqual([plain, underscore]);
    expect(await ids('?q=26-00')).toEqual([reference]);
    expect(await ids('?q=ref-2026')).toEqual([reference]);
    expect((await list('?q=file')).body.matching.value).toBe(2);
    await app.close();
  });

  it('can use the trigram indexes of the title and the case reference for a fragment of 3 or more characters over 5,000 rows, when the other indexes are not there to be chosen', async () => {
    const { database, app, ownerId } = await running();
    await rows(
      database.ownerUrl,
      `INSERT INTO investigations (id, source_id, source_identity_hash, owner_id, title, case_ref, status)
       SELECT gen_random_uuid(), 'demo', 'h', $1, 'Title ' || n, 'REF-' || n, 'open' FROM generate_series(1, 5000) AS n`,
      [ownerId],
    );
    await rows(database.ownerUrl, 'DROP INDEX investigations_owner_edited, investigations_source_edited, investigations_open_case_ref');
    await rows(database.ownerUrl, 'ANALYZE investigations');
    const client = new pg.Client({ connectionString: database.ownerUrl });
    await client.connect();
    try {
      await client.query('SET enable_seqscan = off');
      const plan = await client.query(`EXPLAIN SELECT i.id FROM investigations i WHERE i.owner_id = $1 AND i.status = 'open' AND i.deleted_at IS NULL AND (i.title ILIKE $2 OR i.case_ref ILIKE $2)`.replace('$1', `'${ownerId}'`).replace(/\$2/g, `'%REF-4242%'`));
      const text = plan.rows.map((row) => String(row['QUERY PLAN'])).join('\n');
      expect(text).toMatch(/investigations_title_trigram/);
      expect(text).toMatch(/investigations_case_ref_trigram/);
    } finally {
      await client.end();
    }
    await app.close();
  });

  it('carries the counts of the caller\'s draft, and null when they were made under another policy version', async () => {
    const { database, app, add, list } = await running();
    const made = await add('demo', at(1));
    expect((await list()).body.items[0]).toMatchObject({ nodeCount: 1, edgeCount: 0 });
    await rows(database.ownerUrl, `UPDATE saved_views SET counts_policy_version = 'another' WHERE investigation_id = $1 AND kind = 'draft'`, [made]);
    expect((await list()).body.items[0]).toMatchObject({ nodeCount: null, edgeCount: null });
    await app.close();
  });

  it('counts the rows the filters select exactly, apart from the library counts', async () => {
    const { database, app, add, list } = await running();
    for (let minute = 0; minute < 6; minute += 1) {
      const made = await add('demo', at(minute), minute === 5 ? { status: 'closed' } : {});
      await rename(database, made, minute < 4 ? `Match ${minute}` : `Other ${minute}`, null);
    }
    const filtered = await list('?limit=2&q=match');
    const plain = await list();
    expect(filtered.body.matching).toEqual({ value: 4, quality: 'exact', scope: 'investigations-matching' });
    expect(filtered.body.counts).toEqual(plain.body.counts);
    expect(plain.body.counts.investigations.value).toBe(5);
    await app.close();
  });
});

describe('the named views across investigations against Postgres', () => {
  type Running = Awaited<ReturnType<typeof running>>;

  async function addView(database: Running['database'], investigationId: string, name: string, createdAt: string, id = uuidv7()): Promise<string> {
    await rows(
      database.ownerUrl,
      `INSERT INTO saved_views (id, investigation_id, kind, name, layout, query_context, mapping_hash, content_hash, node_count, edge_count, counts_policy_version, created_by, created_at, updated_at)
       SELECT $1, investigation_id, 'named', $3, layout, query_context, mapping_hash, content_hash, node_count, edge_count, counts_policy_version, created_by, $4, $4 FROM saved_views WHERE investigation_id = $2 AND kind = 'draft'`,
      [id, investigationId, name, createdAt],
    );
    return id;
  }

  const views = async (app: Running['app'], query = '') => {
    const response = await app.inject({ method: 'GET', url: `/v1/views${query}` });
    return { status: response.statusCode, body: response.json() };
  };

  it('lists the views of every status newest first with their investigation, and the Home card counts the same views', async () => {
    const { database, app, add, list } = await running(['secret']);
    const [other] = await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'issuer', 'second', 'Second') RETURNING id`, [uuidv7()]);
    const open = await add('demo', at(1));
    const closed = await add('other', at(2), { status: 'closed' });
    const archived = await add('retired', at(3), { status: 'archived', model: 'retired' });
    const oldest = await addView(database, open, 'Oldest', '2026-11-05T13:00:01Z');
    const middle = await addView(database, closed, 'Middle', '2026-11-05T13:00:02Z');
    const newest = await addView(database, archived, 'Newest', '2026-11-05T13:00:03Z');
    await addView(database, await add('demo', at(4), { deleted: true }), 'Deleted', '2026-11-05T13:00:04Z');
    await addView(database, await add('demo', at(5), { owner: String(other?.['id']) }), 'Not mine', '2026-11-05T13:00:05Z');
    await addView(database, await add('secret', at(6)), 'Refused', '2026-11-05T13:00:06Z');
    const answer = ownedViewListResponseSchema.parse((await views(app)).body);
    expect(answer.items.map((item) => item.id)).toEqual([newest, middle, oldest]);
    expect(answer.items.map((item) => item.investigation.status)).toEqual(['archived', 'closed', 'open']);
    expect(answer.items[0]?.investigation).toMatchObject({ sourceId: 'retired', sourceAlias: 'retired' });
    expect(answer.count).toEqual({ value: 3, quality: 'exact', scope: 'named-views' });
    expect((await list()).body.counts.savedViews.count.value).toBe(answer.count.value);
    await app.close();
  });

  it('pages 30 views 25 at a time and reaches each once, also when a view is added between two calls', async () => {
    const { database, app, add } = await running();
    const owner = await add('demo', at(1));
    for (let second = 0; second < 30; second += 1) await addView(database, owner, `View ${second}`, new Date(Date.UTC(2026, 10, 5, 13, 0, second)).toISOString());
    const first = ownedViewListResponseSchema.parse((await views(app)).body);
    expect(first.items).toHaveLength(25);
    await addView(database, owner, 'Late', '2026-11-05T14:00:00Z');
    const second = ownedViewListResponseSchema.parse((await views(app, `?cursor=${encodeURIComponent(first.nextCursor ?? '')}`)).body);
    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(second.nextCursor).toBeNull();
    expect(new Set(ids).size).toBe(30);
    await app.close();
  });

  it('has the index of named views, uses it for the first page, and answers the same without it', async () => {
    const { database, app, add } = await running();
    const owner = await add('demo', at(1));
    for (let second = 0; second < 40; second += 1) await addView(database, owner, `View ${second}`, new Date(Date.UTC(2026, 10, 5, 13, 0, second)).toISOString());
    expect(await rows(database.ownerUrl, `SELECT indexname FROM pg_indexes WHERE indexname = 'saved_views_named_created'`)).toHaveLength(1);
    const client = new pg.Client({ connectionString: database.ownerUrl });
    await client.connect();
    try {
      await client.query('SET enable_seqscan = off');
      const plan = await client.query(`EXPLAIN SELECT v.id FROM saved_views v WHERE v.kind = 'named' ORDER BY v.created_at DESC, v.id DESC LIMIT 26`);
      expect(plan.rows.map((row) => String(row['QUERY PLAN'])).join('\n')).toMatch(/saved_views_named_created/);
    } finally {
      await client.end();
    }
    const before = ownedViewListResponseSchema.parse((await views(app)).body);
    await rows(database.ownerUrl, 'DROP INDEX saved_views_named_created');
    const without = ownedViewListResponseSchema.parse((await views(app)).body);
    expect({ items: without.items, count: without.count }).toEqual({ items: before.items, count: before.count });
    await app.close();
  });
});
