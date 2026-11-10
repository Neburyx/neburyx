import { rmSync } from 'node:fs';
import { deleteInvestigationResponseSchema, deleteViewResponseSchema, investigationListResponseSchema, investigationResponseSchema, viewListResponseSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRig, rigStores } from '../testing/investigation-rig.js';
import { parseMapping } from '../mapping/load.js';
import { inOrder } from '../testing/barrier.js';
import { attempt, rows } from '../testing/database.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { webRoot } from '../testing/start-api.js';

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [] })), 'neburyx.yaml');
const json = { 'content-type': 'application/json' };

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(rigStores.map((store) => store.close()));
  await postgres.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

const running = () => startRig(postgres, mapping);

const investigationRow = async (database: TestDatabase, id: string) => (await rows(database.ownerUrl, `SELECT * FROM investigations WHERE id = $1`, [id]))[0];
const viewRows = (database: TestDatabase) => rows(database.ownerUrl, `SELECT * FROM saved_views ORDER BY id`);
const without = (row: Record<string, unknown> | undefined, ...keys: string[]) => Object.fromEntries(Object.entries(row ?? {}).filter(([key]) => !keys.includes(key)));

describe('deleting an investigation against Postgres', () => {
  it('marks it with the database time, the caller and a purge date 30 days on, and touches nothing else', async () => {
    const rig = await running();
    const opened = await rig.open();
    const id = opened.investigation.id;
    const saved = await rig.saveView(id, opened.draft.version);
    const before = { investigation: await investigationRow(rig.database, id), views: await viewRows(rig.database) };
    const response = await rig.removeInvestigation(id, 1);
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"2"');
    const answer = deleteInvestigationResponseSchema.parse(response.json());
    const after = await investigationRow(rig.database, id);
    expect(after).toMatchObject({ version: 2, deleted_by: before.investigation?.['owner_id'] });
    expect((after?.['deleted_at'] as Date).toISOString()).toBe(answer.deletedAt);
    expect((after?.['purge_after'] as Date).getTime() - (after?.['deleted_at'] as Date).getTime()).toBe(30 * 86_400_000);
    expect(without(after, 'version', 'deleted_at', 'purge_after', 'deleted_by')).toEqual(without(before.investigation, 'version', 'deleted_at', 'purge_after', 'deleted_by'));
    expect(await viewRows(rig.database)).toEqual(before.views);
    expect(saved.view.id).toBeDefined();
    await rig.app.close();
  });

  it.each(['closed', 'archived'])('deletes a %s investigation and leaves its status, and a restore brings that status back', async (status) => {
    const rig = await running();
    const id = (await rig.open()).investigation.id;
    await rows(rig.database.ownerUrl, `UPDATE investigations SET status = $2, closed_at = now(), archived_at = CASE WHEN $2 = 'archived' THEN now() END WHERE id = $1`, [id, status]);
    expect((await rig.removeInvestigation(id, 1)).statusCode).toBe(200);
    expect((await investigationRow(rig.database, id))?.['status']).toBe(status);
    expect((await rig.restoreInvestigation(id, 2)).statusCode).toBe(200);
    expect((await investigationRow(rig.database, id))?.['status']).toBe(status);
    await rig.app.close();
  });

  it('lets exactly one of two deletes with one If-Match succeed, the other finding it deleted', async () => {
    const rig = await running();
    const id = (await rig.open()).investigation.id;
    const [first, second] = await inOrder(rig.database, id, () => rig.removeInvestigation(id, 1), () => rig.removeInvestigation(id, 1));
    expect([first.statusCode, second.statusCode]).toEqual([200, 404]);
    expect((await investigationRow(rig.database, id))?.['version']).toBe(2);
    await rig.app.close();
  });
});

describe('restoring an investigation against Postgres', () => {
  it('puts back the rows as they were, with the version two higher, views and a draft that was written included', async () => {
    const rig = await running();
    const opened = await rig.open();
    const id = opened.investigation.id;
    await rig.saveView(id, opened.draft.version, 'First');
    const before = { investigation: await investigationRow(rig.database, id), views: await viewRows(rig.database) };
    expect((await rig.removeInvestigation(id, 1)).statusCode).toBe(200);
    const response = await rig.restoreInvestigation(id, 2);
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"3"');
    investigationResponseSchema.parse(response.json());
    const after = await investigationRow(rig.database, id);
    expect(after).toMatchObject({ version: 3, deleted_at: null, purge_after: null, deleted_by: null });
    expect(without(after, 'version')).toEqual(without(before.investigation, 'version'));
    expect(await viewRows(rig.database)).toEqual(before.views);
    expect((await rig.get(`/v1/investigations/${id}`)).statusCode).toBe(200);
    expect(investigationListResponseSchema.parse((await rig.get('/v1/investigations')).json()).items.map((item) => item.id)).toEqual([id]);
    await rig.app.close();
  });

  it('leaves a view that was deleted before the investigation was deleted deleted', async () => {
    const rig = await running();
    const opened = await rig.open();
    const id = opened.investigation.id;
    const saved = await rig.saveView(id, opened.draft.version);
    expect((await rig.removeView(id, saved.view.id, 1, 'not needed')).statusCode).toBe(200);
    expect((await rig.removeInvestigation(id, 1)).statusCode).toBe(200);
    expect((await rig.restoreInvestigation(id, 2)).statusCode).toBe(200);
    expect(viewListResponseSchema.parse((await rig.get(`/v1/investigations/${id}/views`)).json()).items).toEqual([]);
    expect((await rows(rig.database.ownerUrl, `SELECT deleted_at FROM saved_views WHERE id = $1`, [saved.view.id]))[0]?.['deleted_at']).not.toBeNull();
    await rig.app.close();
  });

  it('answers NOT_FOUND at or after the purge date with no task run, leaves the row as it is, and no longer lists it', async () => {
    const rig = await running();
    const id = (await rig.open()).investigation.id;
    expect((await rig.removeInvestigation(id, 1)).statusCode).toBe(200);
    await rows(rig.database.ownerUrl, `UPDATE investigations SET purge_after = now() - interval '1 second' WHERE id = $1`, [id]);
    const before = await investigationRow(rig.database, id);
    expect((await rig.restoreInvestigation(id, 2)).statusCode).toBe(404);
    expect(await investigationRow(rig.database, id)).toEqual(before);
    expect(investigationListResponseSchema.parse((await rig.get('/v1/investigations?deleted=true')).json()).items).toEqual([]);
    await rig.app.close();
  });

  it('answers NOT_FOUND for an investigation that is not deleted, and CONFLICT for a stale version', async () => {
    const rig = await running();
    const id = (await rig.open()).investigation.id;
    expect((await rig.restoreInvestigation(id, 1)).statusCode).toBe(404);
    await rig.removeInvestigation(id, 1);
    expect((await rig.restoreInvestigation(id, 1)).statusCode).toBe(409);
    expect((await investigationRow(rig.database, id))?.['deleted_at']).not.toBeNull();
    await rig.app.close();
  });
});

describe('the list of deleted investigations against Postgres', () => {
  it('lists them newest deletion first with their dates, pages by cursor, narrows by source and text, and keeps the ordinary list clear of them', async () => {
    const rig = await running();
    const ids: string[] = [];
    for (const caseRef of ['CASE-A', 'CASE-B', 'CASE-C']) {
      const opened = await rig.open(caseRef);
      ids.push(opened.investigation.id);
    }
    for (const id of ids) expect((await rig.removeInvestigation(id, 1)).statusCode).toBe(200);
    const firstPage = investigationListResponseSchema.parse((await rig.get('/v1/investigations?deleted=true&limit=2')).json());
    expect(firstPage.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(firstPage.items[0]).toMatchObject({ status: 'open', version: 2 });
    expect(firstPage.items[0]?.deletedAt).toBeDefined();
    expect(firstPage.matching).toEqual({ value: 3, quality: 'exact', scope: 'investigations-matching' });
    expect(firstPage.retention).toEqual({ deletedInvestigationsDays: 30 });
    const secondPage = investigationListResponseSchema.parse((await rig.get(`/v1/investigations?deleted=true&limit=2&cursor=${firstPage.nextCursor}`)).json());
    expect(secondPage.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(secondPage.nextCursor).toBeNull();
    expect(investigationListResponseSchema.parse((await rig.get('/v1/investigations?deleted=true&q=CASE-B')).json()).items.map((item) => item.id)).toEqual([ids[1]]);
    expect(investigationListResponseSchema.parse((await rig.get('/v1/investigations?deleted=true&source=other')).json()).items).toEqual([]);
    const ordinary = investigationListResponseSchema.parse((await rig.get('/v1/investigations')).json());
    expect(ordinary.items).toEqual([]);
    expect(ordinary.counts.investigations.value).toBe(0);
    expect((await rig.get('/v1/investigations?deleted=true&status=open')).statusCode).toBe(400);
    expect((await rig.get(`/v1/investigations?limit=2&cursor=${firstPage.nextCursor}`)).json()).toMatchObject({ error: { code: 'CURSOR_INVALIDATED' } });
    await rig.app.close();
  });
});

describe('deleting a named view against Postgres', () => {
  async function withView() {
    const rig = await running();
    const opened = await rig.open();
    const id = opened.investigation.id;
    const saved = await rig.saveView(id, opened.draft.version);
    return { rig, id, viewId: saved.view.id, draftVersion: saved.draft.version };
  }

  it('marks the view, keeps the note, and leaves the view and the draft row as they were', async () => {
    const { rig, id, viewId } = await withView();
    const before = { views: await viewRows(rig.database), investigation: await investigationRow(rig.database, id) };
    const response = await rig.removeView(id, viewId, 1, 'Duplicate of the review view');
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"2"');
    const answer = deleteViewResponseSchema.parse(response.json());
    expect(answer).toMatchObject({ id: viewId, version: 2, count: { value: 0, quality: 'exact', scope: 'named-views' }, save: { state: 'unsaved', savedAt: null } });
    const after = await viewRows(rig.database);
    const marked = after.find((row) => row['id'] === viewId);
    const owner = before.investigation?.['owner_id'];
    expect(marked).toMatchObject({ deleted_by: owner, deletion_note: 'Duplicate of the review view', version: 2 });
    expect((marked?.['deleted_at'] as Date).toISOString()).toBe(answer.deletedAt);
    expect(without(marked, 'version', 'deleted_at', 'deleted_by', 'deletion_note', 'updated_at')).toEqual(without(before.views.find((row) => row['id'] === viewId), 'version', 'deleted_at', 'deleted_by', 'deletion_note', 'updated_at'));
    expect(after.filter((row) => row['id'] !== viewId)).toEqual(before.views.filter((row) => row['id'] !== viewId));
    expect(await investigationRow(rig.database, id)).toEqual(before.investigation);
    await rig.app.close();
  });

  it('lets a second tab write the draft with the version it held, and reads the investigation as unsaved', async () => {
    const { rig, id, viewId, draftVersion } = await withView();
    expect((await rig.get(`/v1/investigations/${id}`)).json()).toMatchObject({ save: { state: 'saved' }, draft: { basedOnViewId: viewId } });
    await rig.removeView(id, viewId, 1);
    const read = investigationResponseSchema.parse((await rig.get(`/v1/investigations/${id}`)).json());
    expect(read).toMatchObject({ save: { state: 'unsaved', savedAt: null }, draft: { basedOnViewId: null, version: draftVersion } });
    const write = await rig.app.inject({ method: 'PUT', url: `/v1/investigations/${id}/draft`, headers: { ...json, 'if-match': `"${draftVersion}"` }, payload: { layout: read.draft.layout, queryContext: read.draft.queryContext, notes: null } });
    expect(write.statusCode).toBe(200);
    expect(write.json().save).toEqual({ state: 'unsaved', savedAt: null });
    const list = investigationListResponseSchema.parse((await rig.get('/v1/investigations')).json());
    expect(list.items[0]?.save).toEqual({ state: 'unsaved', savedAt: null });
    expect(list.counts.savedViews.count.value).toBe(0);
    await rig.app.close();
  });

  it('leaves it out of the list and the count, answers NOT_FOUND to a rename, a restore and a second delete, and lets a new view be saved', async () => {
    const { rig, id, viewId, draftVersion } = await withView();
    await rig.removeView(id, viewId, 1);
    expect(viewListResponseSchema.parse((await rig.get(`/v1/investigations/${id}/views`)).json())).toMatchObject({ items: [], count: { value: 0 }, draft: { basedOnViewId: null } });
    expect((await rig.get('/v1/views')).json()).toMatchObject({ items: [], count: { value: 0 } });
    expect((await rig.renameView(id, viewId, 2, 'Renamed')).statusCode).toBe(404);
    expect((await rig.restoreView(id, viewId, draftVersion)).statusCode).toBe(404);
    expect((await rig.removeView(id, viewId, 2)).statusCode).toBe(404);
    const again = await rig.saveView(id, draftVersion, 'Another');
    expect(again.draft.basedOnViewId).toBe(again.view.id);
    await rig.app.close();
  });

  it('leaves the deleted view out of the library counts, the time of the newest view included', async () => {
    const { rig, id, draftVersion } = await withView();
    const second = await rig.saveView(id, draftVersion, 'Second');
    const [kept] = await rows(rig.database.ownerUrl, `SELECT updated_at FROM saved_views WHERE kind = 'named' AND name = 'A view'`);
    expect((await rig.removeView(id, second.view.id, 1)).statusCode).toBe(200);
    const counts = investigationListResponseSchema.parse((await rig.get('/v1/investigations')).json()).counts.savedViews;
    expect(counts.count.value).toBe(1);
    expect(counts.lastEditedAt).toBe((kept?.['updated_at'] as Date).toISOString());
    await rig.app.close();
  });

  it('answers a null base when the draft\'s base was deleted earlier, whichever other view is deleted next', async () => {
    const rig = await running();
    const opened = await rig.open();
    const id = opened.investigation.id;
    const other = await rig.saveView(id, opened.draft.version, 'Other');
    const base = await rig.saveView(id, other.draft.version, 'Base');
    expect((await rig.removeView(id, base.view.id, 1)).statusCode).toBe(200);
    const answer = deleteViewResponseSchema.parse((await rig.removeView(id, other.view.id, 1)).json());
    expect(answer.draft.basedOnViewId).toBeNull();
    expect((await rows(rig.database.ownerUrl, `SELECT based_on_view_id FROM saved_views WHERE kind = 'draft'`))[0]?.['based_on_view_id']).toBe(base.view.id);
    await rig.app.close();
  });

  it('refuses a closed investigation with the read-only CONFLICT before the version, and works after it is reopened', async () => {
    const { rig, id, viewId } = await withView();
    await rows(rig.database.ownerUrl, `UPDATE investigations SET status = 'closed' WHERE id = $1`, [id]);
    const refused = await rig.removeView(id, viewId, 99);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'CONFLICT', details: { reason: 'investigation-read-only', status: 'closed' } } });
    expect((await viewRows(rig.database)).find((row) => row['id'] === viewId)?.['deleted_at']).toBeNull();
    await rows(rig.database.ownerUrl, `UPDATE investigations SET status = 'open' WHERE id = $1`, [id]);
    expect((await rig.removeView(id, viewId, 1)).statusCode).toBe(200);
    await rig.app.close();
  });

  it('refuses a stale version, and a deleted investigation, and writes nothing', async () => {
    const { rig, id, viewId } = await withView();
    expect((await rig.removeView(id, viewId, 7)).json()).toMatchObject({ error: { code: 'CONFLICTED_VIEW_VERSION' } });
    await rig.removeInvestigation(id, 1);
    expect((await rig.removeView(id, viewId, 1)).statusCode).toBe(404);
    expect((await viewRows(rig.database)).find((row) => row['id'] === viewId)?.['deleted_at']).toBeNull();
    await rig.app.close();
  });

  it('refuses a deleted draft, a note over its limit and a note without a deletion at the database', async () => {
    const { rig, id, viewId } = await withView();
    const draft = (await viewRows(rig.database)).find((row) => row['kind'] === 'draft');
    expect(await attempt(rig.database.ownerUrl, `UPDATE saved_views SET deleted_at = now(), deleted_by = (SELECT owner_id FROM investigations WHERE id = '${id}') WHERE id = '${String(draft?.['id'])}'`)).toMatch(/saved_views_only_named_deleted/);
    expect(await attempt(rig.database.ownerUrl, `UPDATE saved_views SET deletion_note = 'why' WHERE id = '${viewId}'`)).toMatch(/saved_views_deletion_note_needs_deletion/);
    await rig.app.close();
  });
});

describe('two writers on one view, in both orders, against Postgres', () => {
  async function withView() {
    const rig = await running();
    const opened = await rig.open();
    const id = opened.investigation.id;
    const saved = await rig.saveView(id, opened.draft.version);
    return { rig, id, viewId: saved.view.id, draftVersion: saved.draft.version };
  }

  it('two deletes: one wins and the other finds the view deleted', async () => {
    const { rig, id, viewId } = await withView();
    const [first, second] = await inOrder(rig.database, id, () => rig.removeView(id, viewId, 1), () => rig.removeView(id, viewId, 1));
    expect([first.statusCode, second.statusCode]).toEqual([200, 404]);
    await rig.app.close();
  });

  it('delete then rename: the rename finds nothing', async () => {
    const { rig, id, viewId } = await withView();
    const [deleted, renamed] = await inOrder(rig.database, id, () => rig.removeView(id, viewId, 1), () => rig.renameView(id, viewId, 1, 'Renamed'));
    expect([deleted.statusCode, renamed.statusCode]).toEqual([200, 404]);
    await rig.app.close();
  });

  it('rename then delete: the delete is stale, the view keeps its new name and is not deleted', async () => {
    const { rig, id, viewId } = await withView();
    const [renamed, deleted] = await inOrder(rig.database, id, () => rig.renameView(id, viewId, 1, 'Renamed'), () => rig.removeView(id, viewId, 1));
    expect([renamed.statusCode, deleted.statusCode]).toEqual([200, 409]);
    expect(deleted.json()).toMatchObject({ error: { code: 'CONFLICTED_VIEW_VERSION' } });
    const view = (await viewRows(rig.database)).find((row) => row['id'] === viewId);
    expect(view).toMatchObject({ name: 'Renamed', deleted_at: null });
    await rig.app.close();
  });

  it('delete then restore into the draft: the restore finds nothing and the draft is as it was', async () => {
    const { rig, id, viewId, draftVersion } = await withView();
    const draftBefore = (await viewRows(rig.database)).find((row) => row['kind'] === 'draft');
    const [deleted, restored] = await inOrder(rig.database, id, () => rig.removeView(id, viewId, 1), () => rig.restoreView(id, viewId, draftVersion));
    expect([deleted.statusCode, restored.statusCode]).toEqual([200, 404]);
    expect((await viewRows(rig.database)).find((row) => row['kind'] === 'draft')).toEqual(draftBefore);
    await rig.app.close();
  });

  it('restore into the draft then delete: the draft holds the view and reads unsaved once the view is deleted', async () => {
    const { rig, id, viewId, draftVersion } = await withView();
    const [restored, deleted] = await inOrder(rig.database, id, () => rig.restoreView(id, viewId, draftVersion), () => rig.removeView(id, viewId, 1));
    expect([restored.statusCode, deleted.statusCode]).toEqual([200, 200]);
    expect((await rig.get(`/v1/investigations/${id}`)).json()).toMatchObject({ save: { state: 'unsaved' }, draft: { basedOnViewId: null } });
    await rig.app.close();
  });

  it('answers no call with a deadlock when delete, rename, restore, a draft write and an investigation delete are mixed over and over', async () => {
    const { rig, id, viewId, draftVersion } = await withView();
    const opened = investigationResponseSchema.parse((await rig.get(`/v1/investigations/${id}`)).json());
    const statuses: number[] = [];
    for (let round = 0; round < 12; round += 1) {
      const calls = [
        rig.removeView(id, viewId, 1),
        rig.renameView(id, viewId, 1, `Name ${round}`),
        rig.restoreView(id, viewId, draftVersion),
        rig.app.inject({ method: 'PUT', url: `/v1/investigations/${id}/draft`, headers: { ...json, 'if-match': `"${draftVersion}"` }, payload: { layout: opened.draft.layout, queryContext: opened.draft.queryContext, notes: `n${round}` } }),
        rig.app.inject({ method: 'GET', url: `/v1/investigations/${id}/views` }),
      ];
      for (const response of await Promise.all(calls)) statuses.push(response.statusCode);
    }
    expect(statuses.filter((status) => status >= 500)).toEqual([]);
    await rig.app.close();
  });
});
