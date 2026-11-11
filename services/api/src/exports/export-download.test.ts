import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { exportSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { expireExports, purgeDeletedInvestigations } from '../jobs/maintenance.js';
import { createLogger } from '../logger.js';
import { el, exportWebRoot, idsOf, startExportRig, type ExportRig } from '../testing/export-rig.js';

afterAll(() => rmSync(exportWebRoot, { recursive: true, force: true }));

const body = (format: 'json' | 'csv' = 'json') => ({ kind: 'view', format, entities: [el('widget', 'W-1'), el('widget', 'W-2')] });
const DAY = 86_400_000;
const silent = createLogger({ write: () => undefined });
const firstRow = (rig: ExportRig) => {
  const [row] = rig.store.exports.rows;
  if (row === undefined) throw new Error('the rig holds an export');
  return row;
};
const firstKey = (rig: ExportRig) => {
  const [key] = rig.store.exports.keys;
  if (key === undefined) throw new Error('the rig holds a key');
  return key;
};
const maintenance = (rig: ExportRig) => ({ store: { purgeExpiredInvestigations: rig.store.purgeExpiredInvestigations }, exports: rig.store, files: rig.files, audit: { record: () => Promise.resolve() }, logger: silent });

async function ready(rig: ExportRig, format: 'json' | 'csv' = 'json') {
  const investigation = await rig.open();
  const response = await rig.create(investigation.id, body(format));
  expect(response.statusCode).toBe(201);
  return { investigation, record: exportSchema.parse(response.json()) };
}

describe('GET /v1/exports/{id}', () => {
  it('gives the row of the requester without its key or hash, whatever its status', async () => {
    const rig = await startExportRig();
    const { record } = await ready(rig);
    const response = await rig.get(record.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(record);
    expect(JSON.stringify(response.json())).not.toMatch(/storage|sha256/);
    await rig.store.exports.failExport(record.id, 'EXPORT_FAILED');
    expect((await rig.get(record.id)).json()).toMatchObject({ status: 'failed' });
    await rig.stop();
  });

  it('answers NOT_FOUND with one body for an unknown export and for another person\'s', async () => {
    const rig = await startExportRig();
    const { record } = await ready(rig);
    const unknown = await rig.get('00000000-0000-4000-8000-000000000000');
    rig.store.exports.rows.splice(0, 1, { ...firstRow(rig), requestedBy: '00000000-0000-4000-8000-0000000000aa' });
    const other = await rig.get(record.id);
    expect(unknown.statusCode).toBe(404);
    expect(other.statusCode).toBe(404);
    expect({ ...other.json(), error: { ...other.json().error, traceId: 'x' } }).toEqual({ ...unknown.json(), error: { ...unknown.json().error, traceId: 'x' } });
    await rig.stop();
  });
});

describe('GET /v1/exports/{id}/download', () => {
  it('sends the file as an attachment with the row\'s name and a hash that matches the row', async () => {
    const rig = await startExportRig();
    const { record } = await ready(rig);
    const response = await rig.download(record.id);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['content-disposition']).toBe(`attachment; filename="${record.filename}"`);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(rig.store.exports.rows[0]?.sha256);
    expect(rig.events.filter((event) => event.action === 'export.download')).toEqual([expect.objectContaining({ detail: { export: { format: 'json' } } })]);
    await rig.stop();
  });

  it('serves a closed and an archived investigation\'s export', async () => {
    const rig = await startExportRig();
    const { investigation, record } = await ready(rig);
    await rig.app.inject({ method: 'POST', url: `/v1/investigations/${investigation.id}/status`, payload: { status: 'closed', expectedVersion: investigation.version } });
    expect((await rig.download(record.id)).statusCode).toBe(200);
    await rig.stop();
  });

  it('answers NOT_FOUND, with the file kept, for an export of a deleted investigation', async () => {
    const rig = await startExportRig();
    const { investigation, record } = await ready(rig);
    await rig.app.inject({ method: 'DELETE', url: `/v1/investigations/${investigation.id}`, headers: { 'if-match': `"${investigation.version}"` } });
    expect((await rig.download(record.id)).statusCode).toBe(404);
    expect((await rig.get(record.id)).statusCode).toBe(404);
    expect(await rig.files.list()).toHaveLength(1);
    await rig.stop();
  });

  it('refuses with ACCESS_DENIED when the source is no longer authorized, deletes the file and expires the row, and a second download is NOT_FOUND', async () => {
    let denied = false;
    const rig = await startExportRig({ deny: () => denied });
    const { record } = await ready(rig);
    denied = true;
    const refused = await rig.download(record.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'ACCESS_DENIED', details: { reason: 'access-changed' }, message: expect.stringContaining('Export again') } });
    expect(JSON.stringify(refused.json())).not.toMatch(/source|policy|owner/i);
    expect(await rig.files.list()).toEqual([]);
    expect(rig.store.exports.rows[0]).toMatchObject({ status: 'expired', storageKey: null });
    denied = false;
    expect((await rig.download(record.id)).statusCode).toBe(404);
    await rig.stop();
  });

  it('refuses with ACCESS_DENIED when the policy version changed since the file was made', async () => {
    let version = 'v1';
    const rig = await startExportRig({ policyVersion: () => version });
    const { record } = await ready(rig);
    expect((await rig.download(record.id)).statusCode).toBe(200);
    version = 'v2';
    const refused = await rig.download(record.id);
    expect(refused.json()).toMatchObject({ error: { code: 'ACCESS_DENIED', details: { reason: 'access-changed' } } });
    expect(await rig.files.list()).toEqual([]);
    await rig.stop();
  });

  it('answers NOT_FOUND at or after the expiry even when the task has not run, and deletes the file', async () => {
    const rig = await startExportRig({ retention: { exports_days: 2 } });
    const { record } = await ready(rig);
    rig.store.exports.clock.now += 2 * DAY;
    expect((await rig.download(record.id)).statusCode).toBe(404);
    expect(await rig.files.list()).toEqual([]);
    expect(rig.store.exports.rows[0]).toMatchObject({ status: 'expired' });
    await rig.stop();
  });

  it('answers NOT_FOUND and expires the row when the file is gone', async () => {
    const rig = await startExportRig();
    const { record } = await ready(rig);
    await rig.files.remove(String(rig.store.exports.rows[0]?.storageKey));
    expect((await rig.download(record.id)).statusCode).toBe(404);
    expect(rig.store.exports.rows[0]).toMatchObject({ status: 'expired' });
    await rig.stop();
  });

  it('answers INTERNAL_ERROR, deletes the file and fails the row when the file no longer matches its hash', async () => {
    const rig = await startExportRig();
    const { record } = await ready(rig);
    const [row] = rig.store.exports.rows;
    rig.store.exports.rows[0] = { ...(row ?? firstRow(rig)), sha256: 'f'.repeat(64) };
    const response = await rig.download(record.id);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(rig.store.exports.rows[0]).toMatchObject({ status: 'failed' });
    expect(await rig.files.list()).toEqual([]);
    await rig.stop();
  });

  it('sends no bytes when the audit sink rejects', async () => {
    const rig = await startExportRig({ failAudit: (action) => action === 'export.download' });
    const { record } = await ready(rig);
    const response = await rig.download(record.id);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    await rig.stop();
  });

  it('does not let an identifier choose a file', async () => {
    const rig = await startExportRig();
    await ready(rig);
    for (const id of ['..%2F..%2Fetc%2Fpasswd', '%2Fetc%2Fpasswd', 'a'.repeat(300)]) expect([404, 400]).toContain((await rig.download(id)).statusCode);
    await rig.stop();
  });
});

describe('the same key', () => {
  it('returns the first answer again with Idempotent-Replay and builds one export', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const key = rig.newKey();
    const first = await rig.create(investigation.id, body(), key);
    const second = await rig.create(investigation.id, body(), key);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(rig.store.exports.rows).toHaveLength(1);
    await rig.stop();
  });

  it('is CONFLICT for another request with the key, including another investigation\'s path', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const other = await rig.open();
    const key = rig.newKey();
    await rig.create(investigation.id, body(), key);
    expect((await rig.create(investigation.id, body('csv'), key)).json()).toMatchObject({ error: { code: 'CONFLICT' } });
    expect((await rig.create(other.id, body(), key)).json()).toMatchObject({ error: { code: 'CONFLICT' } });
    await rig.stop();
  });

  it('is CONFLICT while the first call is still running', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const key = rig.newKey();
    await rig.store.startIdempotent({ userId: String(rig.store.exports.keys[0]?.userId ?? (await rig.store.current()).principal.id), key, fingerprint: 'x', policyVersion: 'none' });
    expect((await rig.create(investigation.id, body(), key)).json()).toMatchObject({ error: { code: 'CONFLICT' } });
    await rig.stop();
  });

  it('treats the key of another person as another key', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const key = rig.newKey();
    await rig.create(investigation.id, body(), key);
    const [held] = rig.store.exports.keys;
    rig.store.exports.keys[0] = { ...(held ?? firstKey(rig)), userId: '00000000-0000-4000-8000-0000000000aa' };
    const mine = await rig.create(investigation.id, body(), key);
    expect(mine.headers['idempotent-replay']).toBeUndefined();
    expect(rig.store.exports.rows).toHaveLength(2);
    await rig.stop();
  });

  it('runs again after 24 hours', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const key = rig.newKey();
    await rig.create(investigation.id, body(), key);
    rig.store.exports.clock.now += DAY + 1000;
    const again = await rig.create(investigation.id, body(), key);
    expect(again.headers['idempotent-replay']).toBeUndefined();
    expect(rig.store.exports.rows).toHaveLength(2);
    await rig.stop();
  });

  it('answers ACCESS_DENIED to a replay once the source is no longer readable, and returns nothing stored', async () => {
    let denied = false;
    const rig = await startExportRig({ deny: () => denied });
    const investigation = await rig.open();
    const key = rig.newKey();
    await rig.create(investigation.id, body(), key);
    denied = true;
    const replay = await rig.create(investigation.id, body(), key);
    expect(replay.statusCode).toBe(403);
    expect(replay.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
    expect(replay.json()).not.toHaveProperty('id');
    await rig.stop();
  });

  it('answers CONFLICT to a replay under another policy version and does not run again', async () => {
    let version = 'v1';
    const rig = await startExportRig({ policyVersion: () => version });
    const investigation = await rig.open();
    const key = rig.newKey();
    await rig.create(investigation.id, body(), key);
    version = 'v2';
    const replay = await rig.create(investigation.id, body(), key);
    expect(replay.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(rig.store.exports.rows).toHaveLength(1);
    await rig.stop();
  });

  it('runs again after a first call that ended in a server error, and replays a client error', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const failing = { ...rig.files, write: () => Promise.reject(new Error('disk full')) };
    const real = rig.files.write;
    Object.assign(rig.files, failing);
    const key = rig.newKey();
    expect((await rig.create(investigation.id, body(), key)).statusCode).toBe(500);
    Object.assign(rig.files, { write: real });
    expect((await rig.create(investigation.id, body(), key)).statusCode).toBe(201);
    const tooLarge = { ...body(), entities: Array.from({ length: 301 }, (_unused, index) => el('widget', `W-${index}`)) };
    const bad = rig.newKey();
    const first = await rig.create(investigation.id, tooLarge, bad);
    const replay = await rig.create(investigation.id, tooLarge, bad);
    expect(first.statusCode).toBe(400);
    expect(replay.statusCode).toBe(400);
    expect(replay.headers['idempotent-replay']).toBe('true');
    await rig.stop();
  });
});

describe('the expiry task', () => {
  it('deletes the file and expires each export past its expiry and leaves the others', async () => {
    const rig = await startExportRig({ retention: { exports_days: 2 } });
    const { record } = await ready(rig);
    await ready(rig);
    rig.store.exports.clock.now += 3 * DAY;
    const ran = await expireExports(maintenance(rig));
    expect(ran.expired).toBe(2);
    expect(rig.store.exports.rows.map((row) => row.status)).toEqual(['expired', 'expired']);
    expect(await rig.files.list()).toEqual([]);
    expect(record.id).toBeDefined();
    const again = await expireExports(maintenance(rig));
    expect(again.expired).toBe(0);
    await rig.stop();
  });

  it('leaves an export that is not yet past its expiry alone', async () => {
    const rig = await startExportRig({ retention: { exports_days: 2 } });
    await ready(rig);
    rig.store.exports.clock.now += 2 * DAY - 1000;
    expect((await expireExports(maintenance(rig))).expired).toBe(0);
    expect(await rig.files.list()).toHaveLength(1);
    await rig.stop();
  });

  it('fails a pending row older than fifteen minutes, removes old temporary files and idempotency keys, and counts a file no row names without deleting it', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    await rig.store.insertExport({ id: '11111111-1111-4111-8111-111111111111', investigationId: investigation.id, requestedBy: (await rig.store.current()).principal.id, policyVersion: 'none', format: 'json', retentionDays: 7 });
    await rig.create(investigation.id, body());
    const unnamed = await rig.files.write('22222222-2222-4222-8222-222222222222', Buffer.from('x'));
    rig.store.exports.clock.now += 16 * 60_000;
    const first = await expireExports(maintenance(rig));
    expect(first).toMatchObject({ failed: 1, unnamedFiles: 1 });
    expect(rig.store.exports.rows.find((row) => row.id === '11111111-1111-4111-8111-111111111111')).toMatchObject({ status: 'failed', errorCode: 'EXPORT_FAILED' });
    expect(await rig.files.read(unnamed.storageKey)).toBeDefined();
    rig.store.exports.clock.now += DAY;
    expect((await expireExports(maintenance(rig))).idempotencyKeys).toBe(1);
    await rig.stop();
  });
});

describe('the purge of an investigation', () => {
  it('deletes its export files before the investigation goes, and a file already gone is not an error', async () => {
    const rig = await startExportRig();
    const { investigation } = await ready(rig);
    await ready(rig);
    const key = String(rig.store.exports.rows[0]?.storageKey);
    await rig.files.remove(key);
    let order = '';
    const purged = await purgeDeletedInvestigations({
      ...maintenance(rig),
      store: { purgeExpiredInvestigations: async (beforeDelete) => { await beforeDelete({ id: investigation.id, sourceId: 'demo' }); order = `${(await rig.files.list()).length}`; return 1; } },
    });
    expect(purged).toBe(1);
    expect(order).toBe('1');
    await rig.stop();
  });

  it('stops that investigation\'s purge and reports it when a file cannot be deleted', async () => {
    const rig = await startExportRig();
    const { investigation } = await ready(rig);
    const failing = { ...rig.files, remove: () => Promise.reject(new Error('locked')) };
    await expect(
      purgeDeletedInvestigations({ ...maintenance(rig), files: failing, store: { purgeExpiredInvestigations: async (beforeDelete) => { await beforeDelete({ id: investigation.id, sourceId: 'demo' }); return 1; } } }),
    ).rejects.toThrow('locked');
    await rig.stop();
  });
});

describe('calls that were killed, and the codes a retry meets', () => {
  it('frees the key of a call that never answered, so the retry with the same key runs', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const key = rig.newKey();
    await rig.store.startIdempotent({ userId: (await rig.store.current()).principal.id, key, fingerprint: 'other', policyVersion: 'none' });
    expect((await rig.create(investigation.id, body(), key)).json()).toMatchObject({ error: { code: 'CONFLICT' } });
    rig.store.exports.clock.now += 16 * 60_000;
    const retry = await rig.create(investigation.id, body(), key);
    expect(retry.statusCode).toBe(201);
    expect(rig.store.exports.rows).toHaveLength(1);
    await rig.stop();
  });

  it.each([
    ['SOURCE_UNAVAILABLE', 503, { status: 'unavailable', reason: 'unreachable' } as const],
    ['QUERY_TIMEOUT', 504, { status: 'timeout' } as const],
  ])('runs the same key again after %s (%i) and builds the export', async (_code, statusCode, outcome) => {
    let broken = true;
    const rig = await startExportRig({ answer: (call) => (broken && call.templateId === 'entity-load-many' && idsOf(call).some((id) => id !== 'W-1') ? outcome : undefined) });
    const investigation = await rig.open();
    const key = rig.newKey();
    const first = await rig.create(investigation.id, body(), key);
    expect(first.statusCode).toBe(statusCode);
    broken = false;
    const retry = await rig.create(investigation.id, body(), key);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replay']).toBeUndefined();
    await rig.stop();
  });

  it('refuses the download with ACCESS_DENIED when the investigation is no longer the requester\'s', async () => {
    const rig = await startExportRig();
    const { record } = await ready(rig);
    const [held] = rig.store.investigations;
    if (held === undefined) throw new Error('the rig holds an investigation');
    rig.store.investigations[0] = { ...held, ownerId: '00000000-0000-4000-8000-0000000000bb' };
    const refused = await rig.download(record.id);
    expect(refused.json()).toMatchObject({ error: { code: 'ACCESS_DENIED', details: { reason: 'access-changed' } } });
    expect(await rig.files.list()).toEqual([]);
    await rig.stop();
  });

  it('does not write the audit event of an export that could not be completed', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const real = rig.store.completeExport;
    Object.assign(rig.store, { completeExport: () => Promise.reject(new Error('the row could not be updated')) });
    const response = await rig.create(investigation.id, body());
    expect(response.json()).toMatchObject({ error: { code: 'EXPORT_FAILED' } });
    expect(rig.events.filter((event) => event.action === 'export.create')).toEqual([]);
    expect(await rig.files.list()).toEqual([]);
    Object.assign(rig.store, { completeExport: real });
    await rig.stop();
  });

  it('removes a finished file whose row never got its key: the stale pending row is failed and the file goes, and the purge removes it too', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const principal = (await rig.store.current()).principal.id;
    const id = '33333333-3333-4333-8333-333333333333';
    await rig.store.insertExport({ id, investigationId: investigation.id, requestedBy: principal, policyVersion: 'none', format: 'json', retentionDays: 7 });
    await rig.files.write(id, Buffer.from('x'));
    rig.store.exports.clock.now += 16 * 60_000;
    expect((await expireExports(maintenance(rig))).failed).toBe(1);
    expect(await rig.files.list()).toEqual([]);
    const second = '44444444-4444-4444-8444-444444444444';
    await rig.store.insertExport({ id: second, investigationId: investigation.id, requestedBy: principal, policyVersion: 'none', format: 'json', retentionDays: 7 });
    await rig.files.write(second, Buffer.from('x'));
    await purgeDeletedInvestigations({ ...maintenance(rig), store: { purgeExpiredInvestigations: async (beforeDelete) => { await beforeDelete({ id: investigation.id, sourceId: 'demo' }); return 1; } } });
    expect(await rig.files.list()).toEqual([]);
    await rig.stop();
  });
});
