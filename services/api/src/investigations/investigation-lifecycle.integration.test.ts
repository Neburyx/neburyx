import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { investigationResponseSchema, openInvestigationResponseSchema, statusChangeResponseSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createAppStore, type AppStore } from '../app-store.js';
import { uuidv7 } from '../identity/uuid.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditSink } from '../seams/seams.js';
import { runCli } from '../testing/cli.js';
import { rows } from '../testing/database.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { startPostgres, type TestDatabase, type TestPostgres } from '../testing/postgres.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { webRoot } from '../testing/start-api.js';

const SHIPPED = fileURLToPath(new URL('../../migrations', import.meta.url));
const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [] })), 'neburyx.yaml');
const WIDGET = plainNode(['Widget'], { widgetId: 'W-1' });

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

async function running(audit?: AuditSink) {
  const database: TestDatabase = await postgres.newDatabase();
  expect((await runCli(['migrate'], { DATABASE_MIGRATION_URL: database.ownerUrl, DATABASE_APP_ROLE: database.appRole }).done).code).toBe(0);
  const raw = createAppStore(database.appUrl, () => undefined, { migrationsDirectory: SHIPPED });
  let closing: Promise<void> | undefined;
  const store: AppStore = { ...raw, close: () => (closing ??= raw.close()) };
  stores.push(store);
  await store.initialize();
  await store.syncSources(mapping.sources);
  const executor = new TestExecutor(withOnlineIndexes(mapping.sources[0] ?? (() => { throw new Error('the mapping has no source'); })(), () => Promise.resolve(entityRows(WIDGET))));
  const seams = { ...communitySeams(), ...(audit === undefined ? {} : { audit }) };
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { executor }).gate, seams });
  const opened = openInvestigationResponseSchema.parse((await app.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' } } })).json());
  const id = opened.investigation.id;
  const status = (state: string, expectedVersion: number) => app.inject({ method: 'POST', url: `/v1/investigations/${id}/status`, payload: { status: state, expectedVersion } });
  const rename = (title: string, expectedVersion: number) => app.inject({ method: 'PUT', url: `/v1/investigations/${id}`, payload: { title, expectedVersion } });
  const draft = (label: string, version: number) =>
    app.inject({
      method: 'PUT',
      url: `/v1/investigations/${id}/draft`,
      headers: { 'if-match': `"${version}"` },
      payload: {
        notes: null,
        layout: { schemaVersion: 1, layout: label, nodes: [{ t: 'widget', id: 'W-1', pinned: false, hidden: false, groupId: null }], edges: [], groups: [] },
        queryContext: { schemaVersion: 1, loaded: { nodes: [{ t: 'widget', id: 'W-1' }], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } },
      },
    });
  const row = async () => (await rows(database.ownerUrl, 'SELECT status, version, title, closed_at, archived_at, last_edited_at FROM investigations'))[0];
  const draftRow = async () => (await rows(database.ownerUrl, `SELECT version, layout FROM saved_views WHERE kind = 'draft'`))[0];
  return { app, database, store, id, status, rename, draft, row, draftRow };
}

describe('the status of an investigation against Postgres', () => {
  it('stores the status, closed_at and archived_at of each change and leaves last_edited_at', async () => {
    const { app, status, row } = await running();
    const start = await row();
    expect((await status('closed', 1)).statusCode).toBe(200);
    const closed = await row();
    expect(closed).toMatchObject({ status: 'closed', version: 2, archived_at: null });
    expect(closed?.['closed_at']).toBeInstanceOf(Date);
    expect(closed?.['last_edited_at']).toEqual(start?.['last_edited_at']);

    expect((await status('archived', 2)).statusCode).toBe(200);
    const archived = await row();
    expect(archived).toMatchObject({ status: 'archived', version: 3 });
    expect(archived?.['closed_at']).toEqual(closed?.['closed_at']);
    expect(archived?.['archived_at']).toBeInstanceOf(Date);

    expect((await status('closed', 3)).statusCode).toBe(409);
    expect(await row()).toEqual(archived);

    expect((await status('open', 3)).statusCode).toBe(200);
    expect(await row()).toMatchObject({ status: 'open', version: 4, closed_at: null, archived_at: null });

    expect((await status('archived', 4)).statusCode).toBe(200);
    expect(await row()).toMatchObject({ status: 'archived', version: 5, closed_at: null });
    expect((await status('open', 5)).statusCode).toBe(200);
    expect(await row()).toMatchObject({ status: 'open', version: 6, closed_at: null, archived_at: null });
    await app.close();
  });

  it('lets one of two changes with the same expectedVersion win and refuses the other with CONFLICT', async () => {
    const { app, status, row } = await running();
    const [first, second] = await Promise.all([status('closed', 1), status('archived', 1)]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const loser = first.statusCode === 409 ? first : second;
    expect(loser.json().error.details).toBeUndefined();
    expect(loser.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(await row()).toMatchObject({ version: 2, status: first.statusCode === 200 ? 'closed' : 'archived' });
    await app.close();
  });

  it('leaves the investigation as it was when the audit sink rejects', async () => {
    const { app, status, row } = await running({ record: () => Promise.reject(new Error('sink down')) });
    const before = await row();
    const response = await status('closed', 1);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(await row()).toEqual(before);
    await app.close();
  });

  it('answers NOT_FOUND to another user, an Administrator included, and changes nothing', async () => {
    const { app, database, id, row, store } = await running();
    const before = await row();
    const otherId = uuidv7();
    await rows(database.ownerUrl, `INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'issuer', 'second', 'Second')`, [otherId]);
    for (const role of ['administrator', 'investigator'] as const) {
      const current = await store.current();
      const other = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: { ...store, current: () => Promise.resolve({ ...current, principal: { ...current.principal, id: otherId, role } }) }, mapping, gate: testSourceGate(mapping).gate });
      const changed = await other.inject({ method: 'POST', url: `/v1/investigations/${id}/status`, payload: { status: 'closed', expectedVersion: 1 } });
      const renamed = await other.inject({ method: 'PUT', url: `/v1/investigations/${id}`, payload: { title: 'Mine now', expectedVersion: 1 } });
      expect([changed.statusCode, renamed.statusCode]).toEqual([404, 404]);
    }
    expect(await row()).toEqual(before);
    await app.close();
  });
});

describe('a deleted investigation against Postgres', () => {
  it('answers NOT_FOUND to a status change and to a rename, and changes nothing', async () => {
    const { app, database, status, rename } = await running();
    await rows(database.ownerUrl, 'UPDATE investigations SET deleted_at = now()');
    const before = JSON.stringify(await rows(database.ownerUrl, 'SELECT * FROM investigations'));
    expect((await status('closed', 1)).statusCode).toBe(404);
    expect((await rename('Back again', 1)).statusCode).toBe(404);
    expect(JSON.stringify(await rows(database.ownerUrl, 'SELECT * FROM investigations'))).toBe(before);
    await app.close();
  });
});

describe('the title of an investigation against Postgres', () => {
  it('lets one of two renames with the same expectedVersion win and refuses the other with CONFLICT', async () => {
    const { app, rename, row } = await running();
    const [first, second] = await Promise.all([rename('First title', 1), rename('Second title', 1)]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    expect(await row()).toMatchObject({ version: 2, title: first.statusCode === 200 ? 'First title' : 'Second title' });
    await app.close();
  });

  it('stores a title of accents and emoji at 200 code points and reads it back equal, with last_edited_at unmoved', async () => {
    const { app, id, rename, row } = await running();
    const start = await row();
    const typed = `é\u{1F600}`.repeat(100);
    expect((await rename(typed, 1)).statusCode).toBe(200);
    expect(await row()).toMatchObject({ title: typed, version: 2, last_edited_at: start?.['last_edited_at'] });
    const read = investigationResponseSchema.parse((await app.inject({ method: 'GET', url: `/v1/investigations/${id}` })).json());
    expect(read.investigation.title).toBe(typed);
    await app.close();
  });
});

describe('a closed investigation against Postgres', () => {
  it('refuses a draft write with the read-only CONFLICT before the version guard, and takes one again once reopened', async () => {
    const { app, status, draft, draftRow } = await running();
    expect((await status('closed', 1)).statusCode).toBe(200);
    const refused = await draft('radial', 99);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'CONFLICT', details: { reason: 'investigation-read-only', status: 'closed' } } });
    expect(await draftRow()).toMatchObject({ version: 1 });
    expect((await status('open', 2)).statusCode).toBe(200);
    expect((await draft('radial', 1)).statusCode).toBe(200);
    expect(await draftRow()).toMatchObject({ version: 2 });
    await app.close();
  });

  it('never stores a draft write after a close made at the same time', async () => {
    for (let round = 0; round < 8; round += 1) {
      const { app, status, draft, draftRow, row } = await running();
      const [written, closed] = await Promise.all([draft(`layout-${round}`, 1), status('closed', 1)]);
      expect(closed.statusCode).toBe(200);
      expect(statusChangeResponseSchema.parse(closed.json()).investigation.status).toBe('closed');
      expect(await row()).toMatchObject({ status: 'closed' });
      if (written.statusCode === 200) expect(await draftRow()).toMatchObject({ version: 2 });
      else {
        expect(written.statusCode).toBe(409);
        expect(written.json()).toMatchObject({ error: { code: 'CONFLICT', details: { reason: 'investigation-read-only' } } });
        expect(await draftRow()).toMatchObject({ version: 1 });
      }
      await app.close();
    }
  });
});
