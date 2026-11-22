import { rmSync } from 'node:fs';
import { exportFileSchema, pngExportSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { el, exportWebRoot, startExportRig, type ExportRig } from '../testing/export-rig.js';

afterAll(() => rmSync(exportWebRoot, { recursive: true, force: true }));

const view = (format: string, extra: object = {}) => ({ kind: 'view', format, entities: [el('widget', 'W-1'), el('widget', 'W-2')], ...extra });
const rows = (rig: ExportRig) => rig.store.exports.rows;
const created = (rig: ExportRig) => rig.events.filter((event) => event.action === 'export.create');

describe('POST /v1/investigations/{id}/exports with format png', () => {
  it('answers the header and a file name, and stores no row and no file', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const response = await rig.create(investigation.id, view('png'));
    expect(response.statusCode).toBe(201);
    const answer = pngExportSchema.parse(response.json());
    expect(answer.filename).toMatch(/^neburyx-export-\d{8}T\d{6}Z\.png$/);
    expect(Object.keys(response.json()).sort()).toEqual(['filename', 'format', 'header']);
    expect(rows(rig)).toHaveLength(0);
    expect(await rig.files.list()).toEqual([]);
    await rig.stop();
  });

  it('has the header of the JSON file of the same view, except for the time', async () => {
    const rig = await startExportRig({ links: ['L-1'] });
    const investigation = await rig.open();
    const refs = { edges: [{ sourceId: 'demo', type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' }] };
    const picture = pngExportSchema.parse((await rig.create(investigation.id, view('png', refs))).json());
    await rig.create(investigation.id, view('json', refs));
    const file = exportFileSchema.parse(JSON.parse((await rig.files.read(String(rows(rig)[0]?.storageKey)))?.toString('utf8') ?? ''));
    const without = (header: typeof picture.header) => ({ ...header, exported: '', lines: header.lines.filter((line) => !line.startsWith('exported time:')) });
    expect(without(picture.header)).toEqual(without(file.header));
    expect(picture.header.lines.some((line) => line.startsWith('exported time: '))).toBe(true);
    await rig.stop();
  });

  it.each([
    ['entities', Array.from({ length: 301 }, (_unused, index) => el('widget', `W-${index}`))],
  ])('refuses a view over the %s limit as for JSON and reads nothing', async (_name, entities) => {
    const rig = await startExportRig({ widgets: () => true });
    const investigation = await rig.open();
    const reads = rig.executor.calls.length;
    const response = await rig.create(investigation.id, { kind: 'view', format: 'png', entities });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'INVALID_REQUEST', details: { reason: 'export-too-large', maxEntities: 300, exceeded: 'entities' } });
    expect(rig.executor.calls.length).toBe(reads);
    expect(created(rig)).toEqual([]);
    await rig.stop();
  });

  it('answers NOT_FOUND and audits a denial when the policy denies the source, reading nothing', async () => {
    let denied = false;
    const rig = await startExportRig({ deny: () => denied });
    const investigation = await rig.open();
    denied = true;
    const reads = rig.executor.calls.length;
    const response = await rig.create(investigation.id, view('png'));
    expect(response.statusCode).toBe(404);
    expect(rig.executor.calls.length).toBe(reads);
    expect(created(rig)).toEqual([expect.objectContaining({ result: 'denied' })]);
    await rig.stop();
  });

  it('answers NOT_FOUND for an investigation that is not the caller\'s', async () => {
    const rig = await startExportRig();
    const response = await rig.create('00000000-0000-4000-8000-000000000000', view('png'));
    expect(response.statusCode).toBe(404);
    expect(created(rig)).toEqual([]);
    await rig.stop();
  });

  it.each([
    ['repointed', { sourceIdentityHash: 'another-database' }],
    ['removed', { sourceId: 'gone' }],
  ] as const)('is refused as source-changed (%s) and reads nothing', async (sourceState, change) => {
    const rig = await startExportRig();
    const opened = await rig.open();
    const [row] = rig.store.investigations;
    if (row === undefined) throw new Error('no investigation');
    rig.store.investigations[0] = { ...row, ...change };
    const reads = rig.executor.calls.length;
    const response = await rig.create(opened.id, view('png'));
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: 'CONFLICT', details: { reason: 'source-changed', sourceState } });
    expect(rig.executor.calls.length).toBe(reads);
    await rig.stop();
  });

  it('audits one event with the format and the counts, and no value', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const response = await rig.create(investigation.id, view('png'));
    expect(created(rig)).toEqual([expect.objectContaining({ result: 'success', sourceId: 'demo', detail: { export: { format: 'png', entities: 2, relationships: 0, maskedFields: 0 } } })]);
    expect(JSON.stringify(rig.events)).not.toContain('W-1');
    expect(JSON.stringify(rig.events)).not.toContain(String(pngExportSchema.parse(response.json()).filename));
    await rig.stop();
  });

  it.each([
    ['an item the person may not read', { hideNode: 'W-2' }],
    ['an item that no longer resolves', { widgets: ['W-1'] }],
    ['an item the person may read but not export', { unexportableNode: 'W-2' }],
  ])('refuses a view holding %s, with no header and no audit success', async (_name, options) => {
    const rig = await startExportRig(options);
    const investigation = await rig.open();
    const response = await rig.create(investigation.id, view('png'));
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: 'INVALID_REQUEST', details: { reason: 'export-view-changed' }, message: expect.stringContaining('Reload the view') });
    expect(response.json()).not.toHaveProperty('header');
    expect(created(rig)).toEqual([]);
    await rig.stop();
  });

  it('reads masked when asked, and the header says how many fields are masked', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const plain = pngExportSchema.parse((await rig.create(investigation.id, view('png', { mask: false }))).json());
    const masked = pngExportSchema.parse((await rig.create(investigation.id, view('png', { mask: true }))).json());
    expect(plain.header.masking).toBe('off');
    expect(masked.header.masking).toEqual({ maskedFields: expect.any(Number) });
    expect(masked.header.lines).toContain(`masking: ${typeof masked.header.masking === 'object' ? masked.header.masking.maskedFields : 0} critical fields masked`);
    await rig.stop();
  });

  it.each(['json', 'csv'])('takes mask on a %s export', async (format) => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const response = await rig.create(investigation.id, view(format, { mask: true }));
    expect(response.statusCode).toBe(201);
    expect(rows(rig)).toHaveLength(1);
    await rig.stop();
  });

  it.each([
    ['an unknown format', view('gif')],
    ['an unknown field', view('png', { title: 'x' })],
  ])('refuses %s', async (_name, body) => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    expect((await rig.create(investigation.id, body)).statusCode).toBe(400);
    await rig.stop();
  });

  it('answers INTERNAL_ERROR with no header when the audit sink rejects', async () => {
    const rig = await startExportRig({ failAudit: (action) => action === 'export.create' });
    const investigation = await rig.open();
    const response = await rig.create(investigation.id, view('png'));
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(response.json()).not.toHaveProperty('header');
    await rig.stop();
  });

  it('answers QUERY_TIMEOUT with no header when the source does not answer in time', async () => {
    const rig = await startExportRig({ answer: (call) => (call.templateId === 'entity-load-many' ? { status: 'timeout' } : undefined) });
    const investigation = await rig.open();
    const response = await rig.create(investigation.id, view('png'));
    expect(response.statusCode).toBe(504);
    expect(response.json().error).toMatchObject({ code: 'QUERY_TIMEOUT' });
    expect(response.json()).not.toHaveProperty('header');
    await rig.stop();
  });

  it('answers the source\'s own code when the read fails', async () => {
    const rig = await startExportRig({ answer: (call) => (call.templateId === 'entity-load-many' ? { status: 'unavailable', reason: 'unreachable' } : undefined) });
    const investigation = await rig.open();
    const response = await rig.create(investigation.id, view('png'));
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(response.json()).not.toHaveProperty('header');
    await rig.stop();
  });
});

describe('the same key on a png export', () => {
  it('returns the first answer again, time included, and audits once', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const key = rig.newKey();
    const first = await rig.create(investigation.id, view('png'), key);
    const second = await rig.create(investigation.id, view('png'), key);
    expect(second.json()).toEqual(first.json());
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(created(rig)).toHaveLength(1);
    await rig.stop();
  });

  it('answers CONFLICT for another body under the same key', async () => {
    const rig = await startExportRig();
    const investigation = await rig.open();
    const key = rig.newKey();
    await rig.create(investigation.id, view('png'), key);
    expect((await rig.create(investigation.id, view('png', { mask: true }), key)).statusCode).toBe(409);
    await rig.stop();
  });

  it('answers ACCESS_DENIED to a replay once the policy denies the source', async () => {
    let denied = false;
    const rig = await startExportRig({ deny: () => denied });
    const investigation = await rig.open();
    const key = rig.newKey();
    await rig.create(investigation.id, view('png'), key);
    denied = true;
    const replay = await rig.create(investigation.id, view('png'), key);
    expect(replay.statusCode).toBe(403);
    expect(replay.json()).not.toHaveProperty('header');
    await rig.stop();
  });

  it('answers CONFLICT to a replay under another policy version', async () => {
    let version = 'v1';
    const rig = await startExportRig({ policyVersion: () => version });
    const investigation = await rig.open();
    const key = rig.newKey();
    await rig.create(investigation.id, view('png'), key);
    version = 'v2';
    expect((await rig.create(investigation.id, view('png'), key)).statusCode).toBe(409);
    await rig.stop();
  });
});
