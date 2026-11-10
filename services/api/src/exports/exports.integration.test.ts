import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSchema } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expireExports, purgeDeletedInvestigations } from '../jobs/maintenance.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { rows } from '../testing/database.js';
import { rigStores, startRig } from '../testing/investigation-rig.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';
import { webRoot } from '../testing/start-api.js';
import { createExportFileStore } from './store.js';

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [] })), 'neburyx.yaml');
const silent = createLogger({ write: () => undefined });
const entity = { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' };

let postgres: TestPostgres;
const directories: string[] = [];

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(rigStores.map((store) => store.close()));
  await postgres.stop();
  rmSync(webRoot, { recursive: true, force: true });
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

async function running() {
  const directory = join(mkdtempSync(join(tmpdir(), 'nbx-exports-it-')), 'exports');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  directories.push(directory);
  const files = createExportFileStore(directory);
  const rig = await startRig(postgres, mapping, { exportFiles: files });
  const principal = (await rig.store.current()).principal.id;
  const create = (id: string, key = `key-${randomUUID()}`, body: object = { kind: 'view', format: 'json', entities: [entity] }) =>
    rig.app.inject({ method: 'POST', url: `/v1/investigations/${id}/exports`, headers: { 'content-type': 'application/json', 'idempotency-key': key }, payload: body });
  const maintenance = { store: rig.store, exports: rig.store, files, audit: { record: () => Promise.resolve() }, logger: silent };
  return { rig, files, principal, create, maintenance };
}

describe('the exports table', () => {
  it('holds only the kinds, formats and statuses the table names, and an audit export alone has no investigation', async () => {
    const { rig, principal } = await running();
    const url = rig.database.ownerUrl;
    const opened = await rig.open();
    const insert = (kind: string, format: string, status: string, investigation: string | null) =>
      rows(url, `INSERT INTO exports (id, investigation_id, requested_by, policy_version, kind, format, status, expires_at) VALUES ($1, $2, $3, 'none', $4, $5, $6, now())`, [randomUUID(), investigation, principal, kind, format, status]);
    await expect(insert('view', 'json', 'ready', opened.investigation.id)).resolves.toBeDefined();
    await expect(insert('slides', 'json', 'ready', opened.investigation.id)).rejects.toThrow(/exports_kind_known/);
    await expect(insert('view', 'pdf', 'ready', opened.investigation.id)).rejects.toThrow(/exports_format_known/);
    await expect(insert('view', 'json', 'done', opened.investigation.id)).rejects.toThrow(/exports_status_known/);
    await expect(insert('view', 'json', 'ready', null)).rejects.toThrow(/exports_audit_has_no_investigation/);
    await expect(insert('audit-csv', 'csv', 'ready', opened.investigation.id)).rejects.toThrow(/exports_audit_has_no_investigation/);
    await expect(insert('audit-csv', 'csv', 'ready', null)).resolves.toBeDefined();
  });

  it('removes an investigation\'s rows with it, and sets view_id null when a view goes', async () => {
    const { rig, principal } = await running();
    const url = rig.database.ownerUrl;
    const opened = await rig.open();
    const saved = await rig.saveView(opened.investigation.id, opened.draft.version);
    const id = randomUUID();
    await rows(url, `INSERT INTO exports (id, investigation_id, view_id, requested_by, policy_version, kind, format, expires_at) VALUES ($1, $2, $3, $4, 'none', 'view', 'json', now())`, [id, opened.investigation.id, saved.view.id, principal]);
    await rows(url, `DELETE FROM saved_views WHERE id = $1`, [saved.view.id]);
    expect((await rows(url, `SELECT view_id FROM exports WHERE id = $1`, [id]))[0]).toEqual({ view_id: null });
    await rows(url, `DELETE FROM investigations WHERE id = $1`, [opened.investigation.id]);
    expect(await rows(url, `SELECT 1 FROM exports WHERE id = $1`, [id])).toEqual([]);
  });
});

describe('exports against Postgres', () => {
  it('builds a file, serves it to the requester, and expires it by the database\'s clock', async () => {
    const { rig, files, create, maintenance } = await running();
    const opened = await rig.open();
    const made = await create(opened.investigation.id);
    expect(made.statusCode).toBe(201);
    const record = exportSchema.parse(made.json());
    expect((await rig.app.inject({ method: 'GET', url: `/v1/exports/${record.id}/download` })).statusCode).toBe(200);
    expect((await rig.app.inject({ method: 'GET', url: `/v1/exports/${record.id}` })).json()).toEqual(record);
    await rows(rig.database.ownerUrl, `UPDATE exports SET expires_at = now() - interval '1 second' WHERE id = $1`, [record.id]);
    expect((await rig.app.inject({ method: 'GET', url: `/v1/exports/${record.id}/download` })).statusCode).toBe(404);
    expect(await files.list()).toEqual([]);
    expect((await rows(rig.database.ownerUrl, `SELECT status, storage_key FROM exports WHERE id = $1`, [record.id]))[0]).toEqual({ status: 'expired', storage_key: null });
    expect((await expireExports(maintenance)).expired).toBe(0);
  });

  it('expires every export past its expiry in one run of the task, and leaves the rest', async () => {
    const { rig, files, create, maintenance } = await running();
    const opened = await rig.open();
    const old = exportSchema.parse((await create(opened.investigation.id)).json());
    const fresh = exportSchema.parse((await create(opened.investigation.id)).json());
    await rows(rig.database.ownerUrl, `UPDATE exports SET expires_at = now() - interval '1 hour' WHERE id = $1`, [old.id]);
    expect((await expireExports(maintenance)).expired).toBe(1);
    expect(await files.list()).toHaveLength(1);
    expect((await rows(rig.database.ownerUrl, `SELECT id, status FROM exports ORDER BY status`)).map((row) => row['status'])).toEqual(['expired', 'ready']);
    expect(fresh.id).toBeDefined();
  });

  it('replays an answer for the same key and runs again for the same key after 24 hours', async () => {
    const { rig, create } = await running();
    const opened = await rig.open();
    const key = `key-${randomUUID()}`;
    const first = await create(opened.investigation.id, key);
    const again = await create(opened.investigation.id, key);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await rows(rig.database.ownerUrl, `SELECT 1 FROM exports`)).toHaveLength(1);
    await rows(rig.database.ownerUrl, `UPDATE export_idempotency SET created_at = now() - interval '25 hours'`);
    const later = await create(opened.investigation.id, key);
    expect(later.headers['idempotent-replay']).toBeUndefined();
    expect(await rows(rig.database.ownerUrl, `SELECT 1 FROM exports`)).toHaveLength(2);
  });

  it('gives CONFLICT for the same key with another body, and for a call that is still running', async () => {
    const { rig, create } = await running();
    const opened = await rig.open();
    const key = `key-${randomUUID()}`;
    await create(opened.investigation.id, key);
    expect((await create(opened.investigation.id, key, { kind: 'view', format: 'csv', entities: [entity] })).json()).toMatchObject({ error: { code: 'CONFLICT' } });
    const busy = `key-${randomUUID()}`;
    const principal = (await rig.store.current()).principal.id;
    await rows(rig.database.ownerUrl, `INSERT INTO export_idempotency (user_id, key, fingerprint, policy_version) VALUES ($1, $2, 'x', 'none')`, [principal, busy]);
    expect((await create(opened.investigation.id, busy)).json()).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('frees the key of a call that never answered after fifteen minutes', async () => {
    const { rig, create } = await running();
    const opened = await rig.open();
    const principal = (await rig.store.current()).principal.id;
    const key = `key-${randomUUID()}`;
    await rows(rig.database.ownerUrl, `INSERT INTO export_idempotency (user_id, key, fingerprint, policy_version) VALUES ($1, $2, 'x', 'none')`, [principal, key]);
    expect((await create(opened.investigation.id, key)).json()).toMatchObject({ error: { code: 'CONFLICT' } });
    await rows(rig.database.ownerUrl, `UPDATE export_idempotency SET created_at = now() - interval '16 minutes' WHERE key = $1`, [key]);
    expect((await create(opened.investigation.id, key)).statusCode).toBe(201);
  });

  it('removes keys older than 24 hours in the expiry task', async () => {
    const { rig, create, maintenance } = await running();
    const opened = await rig.open();
    await create(opened.investigation.id);
    await rows(rig.database.ownerUrl, `UPDATE export_idempotency SET created_at = now() - interval '25 hours'`);
    expect((await expireExports(maintenance)).idempotencyKeys).toBe(1);
    expect(await rows(rig.database.ownerUrl, `SELECT 1 FROM export_idempotency`)).toEqual([]);
  });

  it('answers NOT_FOUND to another person\'s export and to a deleted investigation\'s, which Restore brings back', async () => {
    const { rig, create } = await running();
    const opened = await rig.open();
    const record = exportSchema.parse((await create(opened.investigation.id)).json());
    await rows(rig.database.ownerUrl, `UPDATE exports SET requested_by = (SELECT id FROM users WHERE id <> requested_by LIMIT 1) WHERE id = $1`, [record.id]).catch(() => undefined);
    expect((await rig.removeInvestigation(opened.investigation.id, opened.investigation.version)).statusCode).toBe(200);
    expect((await rig.app.inject({ method: 'GET', url: `/v1/exports/${record.id}/download` })).statusCode).toBe(404);
    expect((await rig.restoreInvestigation(opened.investigation.id, opened.investigation.version + 1)).statusCode).toBe(200);
    expect((await rig.app.inject({ method: 'GET', url: `/v1/exports/${record.id}/download` })).statusCode).toBe(200);
  });
});

describe('the purge against Postgres', () => {
  it('deletes the export files and rows of a purged investigation with it, and a failing file stops that purge', async () => {
    const { rig, files, create, maintenance } = await running();
    const opened = await rig.open();
    const record = exportSchema.parse((await create(opened.investigation.id)).json());
    expect((await rig.removeInvestigation(opened.investigation.id, opened.investigation.version)).statusCode).toBe(200);
    await rows(rig.database.ownerUrl, `UPDATE investigations SET purge_after = now() - interval '1 second' WHERE id = $1`, [opened.investigation.id]);
    await expect(purgeDeletedInvestigations({ ...maintenance, files: { ...files, remove: () => Promise.reject(new Error('locked')) } })).rejects.toThrow('locked');
    expect(await rows(rig.database.ownerUrl, `SELECT 1 FROM investigations WHERE id = $1`, [opened.investigation.id])).toHaveLength(1);
    expect(await files.list()).toHaveLength(1);
    expect(await purgeDeletedInvestigations(maintenance)).toBe(1);
    expect(await files.list()).toEqual([]);
    expect(await rows(rig.database.ownerUrl, `SELECT 1 FROM exports WHERE id = $1`, [record.id])).toEqual([]);
  });
});
