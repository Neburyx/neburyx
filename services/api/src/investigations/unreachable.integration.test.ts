import { rmSync } from 'node:fs';
import { investigationResponseSchema, openInvestigationResponseSchema } from '@neburyx/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows } from '../testing/database.js';
import { rigStores, startRig } from '../testing/investigation-rig.js';
import { parseMapping } from '../mapping/load.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';
import { webRoot } from '../testing/start-api.js';
import { DELETED_INVESTIGATION_ROUTES } from './deleted-routes.js';

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [] })), 'neburyx.yaml');
const json = { 'content-type': 'application/json' };
const UNKNOWN = '0192f000-0000-7000-8000-0000000000ff';

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(rigStores.map((store) => store.close()));
  await postgres.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

type Rig = Awaited<ReturnType<typeof startRig>>;
interface Target {
  readonly id: string;
  readonly viewId: string;
  readonly draftVersion: number;
  readonly document: { readonly layout: unknown; readonly queryContext: unknown };
}

async function deletedTarget(rig: Rig): Promise<Target> {
  const opened = await rig.open('CASE-1');
  const id = opened.investigation.id;
  const saved = await rig.saveView(id, opened.draft.version);
  const read = investigationResponseSchema.parse((await rig.get(`/v1/investigations/${id}`)).json());
  expect((await rig.removeInvestigation(id, 1)).statusCode).toBe(200);
  return { id, viewId: saved.view.id, draftVersion: saved.draft.version, document: { layout: read.draft.layout, queryContext: read.draft.queryContext } };
}

const CALLS: Readonly<Record<string, (rig: Rig, target: Target, id: string, viewId: string) => Promise<LightMyRequestResponse>>> = {
  'GET /v1/investigations/:id': (rig, _t, id) => rig.get(`/v1/investigations/${id}`),
  'PUT /v1/investigations/:id': (rig, _t, id) => rig.app.inject({ method: 'PUT', url: `/v1/investigations/${id}`, headers: json, payload: { title: 'Renamed', expectedVersion: 2 } }),
  'DELETE /v1/investigations/:id': (rig, _t, id) => rig.removeInvestigation(id, 2),
  'PUT /v1/investigations/:id/draft': (rig, target, id) => rig.app.inject({ method: 'PUT', url: `/v1/investigations/${id}/draft`, headers: { ...json, 'if-match': `"${target.draftVersion}"` }, payload: { ...target.document, notes: 'x' } }),
  'POST /v1/investigations/:id/status': (rig, _t, id) => rig.app.inject({ method: 'POST', url: `/v1/investigations/${id}/status`, headers: json, payload: { status: 'closed', expectedVersion: 2 } }),
  'POST /v1/investigations/:id/restore': (rig, _t, id) => rig.restoreInvestigation(id, 2),
  'GET /v1/investigations/:id/views': (rig, _t, id) => rig.get(`/v1/investigations/${id}/views`),
  'POST /v1/investigations/:id/views': (rig, target, id) => rig.app.inject({ method: 'POST', url: `/v1/investigations/${id}/views`, headers: { ...json, 'if-match': `"${target.draftVersion}"` }, payload: { name: 'New', notes: null } }),
  'PUT /v1/investigations/:id/views/:viewId': (rig, _t, id, viewId) => rig.renameView(id, viewId, 1, 'Renamed'),
  'POST /v1/investigations/:id/views/:viewId/restore': (rig, target, id, viewId) => rig.restoreView(id, viewId, target.draftVersion),
  'POST /v1/investigations/:id/views/:viewId/delete': (rig, _t, id, viewId) => rig.removeView(id, viewId, 1, 'why'),
};

const errorOf = (response: LightMyRequestResponse) => {
  const { error } = response.json() as { error: { traceId?: string } & Record<string, unknown> };
  const { traceId: _trace, ...rest } = error;
  return { status: response.statusCode, error: rest };
};

const snapshot = async (rig: Rig) => JSON.stringify([await rows(rig.database.ownerUrl, 'SELECT * FROM investigations ORDER BY id'), await rows(rig.database.ownerUrl, 'SELECT * FROM saved_views ORDER BY id')]);

describe('a deleted investigation, route by route, against Postgres', () => {
  it('has a call for every route in the inventory', () => {
    expect(Object.keys(CALLS).sort()).toEqual(Object.keys(DELETED_INVESTIGATION_ROUTES).sort());
  });

  const unreachable = Object.entries(DELETED_INVESTIGATION_ROUTES).filter(([, kind]) => kind === 'unreachable').map(([route]) => route);

  it.each(unreachable)('%s answers what an unknown ID answers, and writes nothing', async (route) => {
    const rig = await running();
    const target = await deletedTarget(rig);
    const before = await snapshot(rig);
    const call = CALLS[route];
    if (call === undefined) throw new Error(`no call for ${route}`);
    const unknown = errorOf(await call(rig, target, UNKNOWN, UNKNOWN));
    const deleted = errorOf(await call(rig, target, target.id, target.viewId));
    expect(unknown.status).toBe(404);
    expect(deleted).toEqual(unknown);
    expect(await snapshot(rig)).toBe(before);
    await rig.app.close();
  });

  it.each(unreachable)('%s answers the same after the purge date has passed and before the task has run', async (route) => {
    const rig = await running();
    const target = await deletedTarget(rig);
    await rows(rig.database.ownerUrl, `UPDATE investigations SET purge_after = now() - interval '1 second' WHERE id = $1`, [target.id]);
    const call = CALLS[route];
    if (call === undefined) throw new Error(`no call for ${route}`);
    const before = await snapshot(rig);
    const unknown = errorOf(await call(rig, target, UNKNOWN, UNKNOWN));
    expect(errorOf(await call(rig, target, target.id, target.viewId))).toEqual(unknown);
    expect(await snapshot(rig)).toBe(before);
    await rig.app.close();
  });

  it('is absent from every list, count and the Home view, and opening the same referral makes a new investigation', async () => {
    const rig = await running();
    const target = await deletedTarget(rig);
    const list = (await rig.get('/v1/investigations')).json();
    expect(list).toMatchObject({ items: [], counts: { investigations: { value: 0 }, sources: { value: 0 }, savedViews: { count: { value: 0 }, lastEditedAt: null } } });
    expect((await rig.get('/v1/investigations?limit=5')).json().items).toEqual([]);
    expect((await rig.get('/v1/investigations?status=closed')).json().items).toEqual([]);
    expect((await rig.get('/v1/views')).json()).toMatchObject({ items: [], count: { value: 0 } });
    const again = openInvestigationResponseSchema.parse((await rig.app.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'demo', caseRef: 'CASE-1', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' } } })).json());
    expect(again.investigation.id).not.toBe(target.id);
    await rig.app.close();
  });

  it('works again through every route once the investigation is restored', async () => {
    const rig = await running();
    const target = await deletedTarget(rig);
    expect((await rig.restoreInvestigation(target.id, 2)).statusCode).toBe(200);
    expect((await rig.get(`/v1/investigations/${target.id}`)).statusCode).toBe(200);
    expect((await rig.get(`/v1/investigations/${target.id}/views`)).statusCode).toBe(200);
    expect((await CALLS['PUT /v1/investigations/:id/draft']?.(rig, target, target.id, target.viewId))?.statusCode).toBe(200);
    expect((await rig.renameView(target.id, target.viewId, 1, 'Renamed')).statusCode).toBe(200);
    const read = investigationResponseSchema.parse((await rig.get(`/v1/investigations/${target.id}`)).json());
    expect((await rig.app.inject({ method: 'PUT', url: `/v1/investigations/${target.id}`, headers: json, payload: { title: 'Renamed', expectedVersion: read.investigation.version } })).statusCode).toBe(200);
    const saved = await rig.app.inject({ method: 'POST', url: `/v1/investigations/${target.id}/views`, headers: { ...json, 'if-match': `"${read.draft.version}"` }, payload: { name: 'After', notes: null } });
    expect(saved.statusCode).toBe(201);
    expect((await rig.restoreView(target.id, target.viewId, read.draft.version + 1)).statusCode).toBe(200);
    expect((await rig.removeView(target.id, target.viewId, 2, 'why')).statusCode).toBe(200);
    expect((await rig.app.inject({ method: 'POST', url: `/v1/investigations/${target.id}/status`, headers: json, payload: { status: 'closed', expectedVersion: read.investigation.version + 1 } })).statusCode).toBe(200);
    expect((await rig.removeInvestigation(target.id, read.investigation.version + 2)).statusCode).toBe(200);
    await rig.app.close();
  });
});

const running = () => startRig(postgres, mapping);
