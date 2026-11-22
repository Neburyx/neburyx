import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportFileSchema, exportSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { el, exportWebRoot, idsOf, linkRef, startExportRig, type ExportRig } from '../testing/export-rig.js';

afterAll(() => rmSync(exportWebRoot, { recursive: true, force: true }));

const two = { kind: 'view', format: 'json', entities: [el('widget', 'W-1'), el('widget', 'W-2')] };
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const rows = (rig: ExportRig) => rig.store.exports.rows;

async function made(rig: ExportRig, body: unknown = two) {
  const investigation = await rig.open();
  const response = await rig.create(investigation.id, body);
  return { investigation, response };
}

describe('POST /v1/investigations/{id}/exports', () => {
  it('builds a ready JSON export whose file begins with the header and whose row holds the hash and the expiry', async () => {
    const rig = await startExportRig({ retention: { exports_days: 3 } });
    const { response } = await made(rig);
    expect(response.statusCode).toBe(201);
    const record = exportSchema.parse(response.json());
    expect(record).toMatchObject({ status: 'ready', format: 'json', filename: expect.stringMatching(/^neburyx-export-\d{8}T\d{6}Z\.json$/) });
    const [row] = rows(rig);
    expect(row).toMatchObject({ requestedBy: expect.any(String), policyVersion: 'none', kind: 'view', masked: false, maskedFieldCount: 0, status: 'ready' });
    const bytes = await rig.files.read(row?.storageKey ?? '');
    expect(bytes).toBeDefined();
    expect(row?.sha256).toBe(sha(bytes ?? ''));
    expect(row?.sizeBytes).toBe(bytes?.length);
    const file = exportFileSchema.parse(JSON.parse(bytes?.toString('utf8') ?? ''));
    expect(Object.keys(JSON.parse(bytes?.toString('utf8') ?? ''))[0]).toBe('header');
    expect(file.header.lines.slice(0, 3)).toEqual(['source: demo', expect.stringMatching(/^exported time: \d/), 'scope: current view (partial)']);
    expect(file.entities.map((node) => node.ref.stableId)).toEqual(['W-1', 'W-2']);
    expect(Date.parse(record.expiresAt) - Date.parse(record.createdAt)).toBe(3 * 86_400_000);
    await rig.stop();
  });

  it('is the same for an investigation that is closed or archived', async () => {
    const rig = await startExportRig();
    for (const status of ['closed', 'archived'] as const) {
      const investigation = await rig.open();
      const changed = await rig.app.inject({ method: 'POST', url: `/v1/investigations/${investigation.id}/status`, payload: { status, expectedVersion: investigation.version } });
      expect(changed.statusCode).toBe(200);
      expect((await rig.create(investigation.id, two)).statusCode).toBe(201);
    }
    await rig.stop();
  });

  it.each([
    ['no key', null],
    ['a short key', 'short'],
    ['a key with a space', 'a key with a space inside it'],
    ['a key that is too long', 'k'.repeat(65)],
  ])('refuses %s with INVALID_REQUEST and builds nothing', async (_name, key) => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const response = await rig.create(investigation.id, two, key);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(rows(rig)).toHaveLength(0);
    await rig.stop();
  });

  it.each([
    ['an unknown field', { ...two, extra: 1 }],
    ['a mask that is not a boolean', { ...two, mask: 'yes' }],
    ['another kind', { ...two, kind: 'table-csv' }],
    ['another format', { ...two, format: 'gif' }],
  ])('refuses %s with INVALID_REQUEST and builds nothing', async (_name, body) => {
    const rig = await startExportRig();
    const { response } = await made(rig, body);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(rows(rig)).toHaveLength(0);
    await rig.stop();
  });

  it('refuses a view that holds more than one export can, names the limit and reads nothing', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const before = rig.executor.calls.length;
    const entities = Array.from({ length: 301 }, (_unused, index) => el('widget', `W-${index}`));
    const response = await rig.create(investigation.id, { ...two, entities });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST', details: { reason: 'export-too-large', maxEntities: 300, maxRelationships: 300, maxAggregates: 100, exceeded: 'entities' }, message: expect.stringContaining('Hide some items') } });
    expect(rig.executor.calls.length).toBe(before);
    expect(rows(rig)).toHaveLength(0);
    await rig.stop();
  });

  it('refuses 101 aggregated relationships and 301 stored ones, each naming the limit it went over, and reads nothing', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const before = rig.executor.calls.length;
    const aggregates = Array.from({ length: 101 }, (_unused, index) => ({ sourceId: 'demo', aggregate: { type: 'BARE', from: el('widget', `W-${index}`), to: el('gadget', 'GT-1') } }));
    const first = await rig.create(investigation.id, { ...two, aggregates });
    expect(first.statusCode).toBe(400);
    expect(first.json().error.details).toEqual({ reason: 'export-too-large', maxEntities: 300, maxRelationships: 300, maxAggregates: 100, exceeded: 'aggregates' });
    const edges = Array.from({ length: 301 }, (_unused, index) => linkRef(`L-${index}`));
    const second = await rig.create(investigation.id, { ...two, edges });
    expect(second.json().error.details).toMatchObject({ exceeded: 'relationships' });
    expect(rig.executor.calls.length).toBe(before);
    expect(rows(rig)).toHaveLength(0);
    await rig.stop();
  });

  it('answers NOT_FOUND for an unknown investigation, another person\'s, and one that is deleted, and builds nothing', async () => {
    const rig = await startExportRig();
    expect((await rig.create('00000000-0000-4000-8000-000000000000', two)).statusCode).toBe(404);
    const investigation = await rig.open();
    const removed = await rig.app.inject({ method: 'DELETE', url: `/v1/investigations/${investigation.id}`, headers: { 'if-match': `"${investigation.version}"` } });
    expect(removed.statusCode).toBe(200);
    expect((await rig.create(investigation.id, two)).statusCode).toBe(404);
    expect(rows(rig)).toHaveLength(0);
    await rig.stop();
  });

  it('answers the read\'s own code with no row and no file when the source is unavailable', async () => {
    const rig = await startExportRig({ answer: (call) => (call.templateId === 'entity-load-many' && idsOf(call).some((id) => id !== 'W-1') ? { status: 'unavailable', reason: 'unreachable' } : undefined) });
    const investigation = await rig.open();
    const response = await rig.create(investigation.id, two);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'SOURCE_UNAVAILABLE' } });
    expect(rows(rig)).toHaveLength(0);
    expect(await rig.files.list()).toEqual([]);
    await rig.stop();
  });

  it('answers EXPORT_FAILED, marks the row failed and leaves no file when the file cannot be written', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const failing = { ...rig.files, write: () => Promise.reject(new Error('disk full')) };
    Object.assign(rig.files, failing);
    const response = await rig.create(investigation.id, two);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'EXPORT_FAILED' } });
    expect(rows(rig)).toMatchObject([{ status: 'failed', errorCode: 'EXPORT_FAILED', storageKey: null }]);
    await rig.stop();
  });

  it('answers INTERNAL_ERROR, deletes the file and fails the row when the audit sink rejects', async () => {
    const rig = await startExportRig({ failAudit: (action) => action === 'export.create' });
    const investigation = await rig.open();
    const response = await rig.create(investigation.id, two);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(rows(rig)).toMatchObject([{ status: 'failed', storageKey: null }]);
    expect(await rig.files.list()).toEqual([]);
    await rig.stop();
  });

  it('records one audit event with the format and counts only, never a value, an ID or a file name', async () => {
    const rig = await startExportRig();
    const { response } = await made(rig);
    const events = rig.events.filter((event) => event.action === 'export.create');
    expect(events).toEqual([expect.objectContaining({ result: 'success', sourceId: 'demo', detail: { export: { format: 'json', entities: 2, relationships: 0, maskedFields: 0 } } })]);
    expect(JSON.stringify(rig.events)).not.toContain('W-1');
    expect(JSON.stringify(rig.events)).not.toContain(String(exportSchema.parse(response.json()).filename));
    await rig.stop();
  });

  it('leaves out an item the person may not read the way it leaves out one that is gone', async () => {
    const hidden = await startExportRig({ hideNode: 'W-2' });
    const gone = await startExportRig({ widgets: ['W-1'] });
    const left = await made(hidden);
    const right = await made(gone);
    const bytesOf = async (rig: ExportRig, response: typeof left.response) => (await rig.files.read(String(rows(rig)[0]?.storageKey))) ?? Buffer.alloc(0);
    const shown = JSON.parse((await bytesOf(hidden, left.response)).toString('utf8')) as { entities: unknown[]; relationships: unknown[] };
    const absent = JSON.parse((await bytesOf(gone, right.response)).toString('utf8')) as { entities: unknown[]; relationships: unknown[] };
    expect(shown.entities).toEqual(absent.entities);
    await hidden.stop();
    await gone.stop();
  });

  it('counts the request once for the rate limit however many batches it reads, and never holds two read slots at once', async () => {
    const rig = await startExportRig({ userConcurrency: 1, widgets: () => true });
    const investigation = await rig.open();
    const entities = Array.from({ length: 250 }, (_unused, index) => el('widget', `W-${index}`));
    const response = await rig.create(investigation.id, { kind: 'view', format: 'json', entities });
    expect(response.statusCode).toBe(201);
    await rig.stop();
  });

  it('reads an edge through the gate and writes it with its ends', async () => {
    const rig = await startExportRig({ links: ['L-1'] });
    const { response } = await made(rig, { kind: 'view', format: 'json', entities: [el('widget', 'W-1')], edges: [linkRef('L-1')] });
    expect(response.statusCode).toBe(201);
    const file = exportFileSchema.parse(JSON.parse((await rig.files.read(String(rows(rig)[0]?.storageKey)))?.toString('utf8') ?? ''));
    expect(file.relationships.map((edge) => edge.type)).toEqual(['MADE_FROM']);
    await rig.stop();
  });

  it('builds a CSV export as one zip of two files, each opening with the header, and the same elements as the JSON', async () => {
    const rig = await startExportRig({ links: ['L-1'] });
    const investigation = await rig.open();
    const request = (format: string) => ({ kind: 'view', format, entities: [el('widget', 'W-1'), el('widget', 'W-2')], edges: [linkRef('L-1')] });
    const csv = exportSchema.parse((await rig.create(investigation.id, request('csv'))).json());
    const json = exportSchema.parse((await rig.create(investigation.id, request('json'))).json());
    expect(csv).toMatchObject({ format: 'csv', filename: expect.stringMatching(/\.zip$/) });
    const download = await rig.download(csv.id);
    expect(download.headers['content-type']).toContain('application/zip');
    const folder = mkdtempSync(join(tmpdir(), 'nbx-route-zip-'));
    writeFileSync(join(folder, 'x.zip'), download.rawPayload);
    const listing = execFileSync('unzip', ['-Z1', join(folder, 'x.zip')], { encoding: 'utf8' }).trim().split('\n');
    expect(listing).toEqual(['entities.csv', 'relationships.csv']);
    for (const name of listing) expect(execFileSync('unzip', ['-p', join(folder, 'x.zip'), name], { encoding: 'utf8' })).toContain('# scope: current view (partial)');
    const entities = execFileSync('unzip', ['-p', join(folder, 'x.zip'), 'entities.csv'], { encoding: 'utf8' });
    expect(entities).toContain('"W-1"');
    expect(entities).toContain('"W-2"');
    const asJson = exportFileSchema.parse(JSON.parse((await rig.download(json.id)).body));
    expect(asJson.entities.map((node) => node.ref.stableId)).toEqual(['W-1', 'W-2']);
    await rig.stop();
  });

  it('counts each request once however many batches it reads, and refuses the one over the limit without reading', async () => {
    const rig = await startExportRig({ requestsPerMinute: 2, widgets: () => true });
    const investigation = await rig.open();
    const big = { kind: 'view', format: 'json', entities: Array.from({ length: 250 }, (_unused, index) => el('widget', `W-${index}`)) };
    expect((await rig.create(investigation.id, big)).statusCode).toBe(201);
    const reads = rig.executor.calls.length;
    expect((await rig.create(investigation.id, big)).statusCode).toBe(429);
    expect(rig.executor.calls.length).toBe(reads);
    expect(rows(rig)).toHaveLength(1);
    await rig.stop();
  });
});

describe('a file made with the mask flag', () => {
  const NAME = 'Ana Silva';
  const MASKED = 'A••• S•••';
  const asked = (format: 'json' | 'csv', mask?: boolean) => ({ kind: 'view', format, entities: [el('widget', 'W-1'), el('gadget', 'GT-1')], edges: [linkRef('L-1')], ...(mask === undefined ? {} : { mask }) });
  const storedText = async (rig: ExportRig, format: 'json' | 'csv'): Promise<string> => {
    const [row] = rows(rig);
    const bytes = await rig.files.read(row?.storageKey ?? '');
    if (format === 'json') return bytes?.toString('utf8') ?? '';
    const folder = mkdtempSync(join(tmpdir(), 'nbx-mask-zip-'));
    writeFileSync(join(folder, 'x.zip'), bytes ?? '');
    return ['entities.csv', 'relationships.csv'].map((name) => execFileSync('unzip', ['-p', join(folder, 'x.zip'), name], { encoding: 'utf8' })).join('\n');
  };

  it.each(['json', 'csv'] as const)('holds no value of a pii field in the stored %s file, holds the mask, and states the count in the header and the audit', async (format) => {
    const rig = await startExportRig({ links: ['L-1'] });
    const investigation = await rig.open();
    const response = await rig.create(investigation.id, asked(format, true));
    expect(response.statusCode).toBe(201);
    const text = await storedText(rig, format);
    expect(text).not.toContain(NAME);
    expect(text).toContain(MASKED);
    expect(text).toContain('masking: 1 critical fields masked');
    expect(rows(rig)).toMatchObject([{ masked: true, maskedFieldCount: 1 }]);
    expect(rig.events.filter((event) => event.action === 'export.create')).toEqual([expect.objectContaining({ detail: { export: expect.objectContaining({ format, maskedFields: 1 }) } })]);
    expect(JSON.stringify(rig.events)).not.toContain(NAME);
    await rig.stop();
  });

  it('marks each masked property of the JSON file as masked by the request', async () => {
    const rig = await startExportRig({ links: ['L-1'] });
    const investigation = await rig.open();
    await rig.create(investigation.id, asked('json', true));
    const file = exportFileSchema.parse(JSON.parse(await storedText(rig, 'json')));
    expect(file.header.masking).toEqual({ maskedFields: 1 });
    const masked = file.entities.flatMap((node) => node.properties).filter((property) => property.masked);
    expect(masked).toMatchObject([{ key: 'ownerName', value: MASKED, maskedBy: 'request' }]);
    await rig.stop();
  });

  it.each([
    ['omitted', undefined],
    ['false', false],
  ] as const)('holds the values and says masking is off when the flag is %s', async (_name, flag) => {
    const rig = await startExportRig({ links: ['L-1'] });
    const investigation = await rig.open();
    await rig.create(investigation.id, asked('json', flag));
    const text = await storedText(rig, 'json');
    expect(text).toContain(NAME);
    expect(text).toContain('masking: off');
    await rig.stop();
  });

  it.each(['json', 'csv'] as const)('says masking is on with no field masked when the %s file was asked to be masked and nothing in the view is marked pii', async (format) => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const response = await rig.create(investigation.id, { kind: 'view', format, entities: [el('gadget', 'GT-1')], mask: true });
    expect(response.statusCode).toBe(201);
    const text = await storedText(rig, format);
    expect(text).toContain('masking: on · 0 fields masked');
    expect(text).not.toContain('masking: off');
    if (format === 'json') expect(exportFileSchema.parse(JSON.parse(text)).header.masking).toEqual({ maskedFields: 0 });
    expect(rows(rig)).toMatchObject([{ masked: true, maskedFieldCount: 0 }]);
    expect(rig.events.filter((event) => event.action === 'export.create')).toEqual([expect.objectContaining({ detail: { export: expect.objectContaining({ maskedFields: 0 }) } })]);
    await rig.stop();
  });

  it.each(['json', 'csv'] as const)('says masking is off when the %s file was not asked to be masked and nothing was', async (format) => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    await rig.create(investigation.id, { kind: 'view', format, entities: [el('gadget', 'GT-1')] });
    expect(await storedText(rig, format)).toContain('masking: off');
    expect(rows(rig)).toMatchObject([{ masked: false, maskedFieldCount: 0 }]);
    await rig.stop();
  });

  it('leaves nothing stored when the masked read fails', async () => {
    let failing = false;
    const rig = await startExportRig({ answer: () => (failing ? { status: 'timeout' } : undefined) });
    const investigation = await rig.open();
    failing = true;
    const response = await rig.create(investigation.id, asked('json', true));
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(rows(rig).filter((row) => row.status === 'ready')).toEqual([]);
    expect(await rig.files.list()).toEqual([]);
    await rig.stop();
  });
});

describe('the same key with a mask', () => {
  const formats = ['json', 'csv', 'png'] as const;
  const asked = (format: string, mask?: boolean) => ({ kind: 'view', format, entities: [el('widget', 'W-1')], ...(mask === undefined ? {} : { mask }) });

  it.each(formats)('returns the first %s answer again and reads, stores and audits nothing more', async (format) => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const key = rig.newKey();
    const first = await rig.create(investigation.id, asked(format, true), key);
    const reads = rig.executor.calls.length;
    const events = rig.events.length;
    const second = await rig.create(investigation.id, asked(format, true), key);
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json());
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(rig.executor.calls.length).toBe(reads);
    expect(rig.events.length).toBe(events);
    expect(rows(rig)).toHaveLength(format === 'png' ? 0 : 1);
    await rig.stop();
  });

  it.each(formats.flatMap((format) => [[format, true, false], [format, true, undefined], [format, false, true], [format, undefined, true], [format, undefined, false], [format, false, undefined]] as const))(
    'is CONFLICT for a %s export first made with mask %s and sent again with %s, and builds nothing more',
    async (format, first, second) => {
      const rig = await startExportRig();
      const investigation = await rig.open();
      const key = rig.newKey();
      await rig.create(investigation.id, asked(format, first), key);
      const reads = rig.executor.calls.length;
      const stored = rows(rig).length;
      const refused = await rig.create(investigation.id, asked(format, second), key);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: { code: 'CONFLICT' } });
      expect(refused.headers['idempotent-replay']).toBeUndefined();
      expect(rig.executor.calls.length).toBe(reads);
      expect(rows(rig)).toHaveLength(stored);
      await rig.stop();
    },
  );
});
