import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExportRequest } from '@neburyx/contracts';
import { AppError, RequestCancelled } from '../errors.js';
import { exportWebRoot, startExportRig } from '../testing/export-rig.js';
import { principalFixture } from '../testing/principal-fixture.js';
import { createExportService } from './export-service.js';
import type { ShownReader } from './shown-reader.js';

afterAll(() => rmSync(exportWebRoot, { recursive: true, force: true }));

const EMPTY = { nodes: [], edges: [], omitted: false, unresolved: false, unresolvedCount: 0, maskedFields: 0, uncounted: 0, notRetrieved: { value: 0, quality: 'exact' as const, scope: 'not yet retrieved' } };
const request: ExportRequest = { kind: 'view', format: 'json', entities: [], edges: [], aggregates: [], derived: [] };

async function service(read: ShownReader['read'], audit: { record(event: { action: string; result: string }): Promise<void> } = { record: () => Promise.resolve() }, refusalAudit: { record(event: { action: string; result: string }): Promise<void> } = { record: () => Promise.resolve() }) {
  const rig = await startExportRig();
  const opened = await rig.open();
  const exports = createExportService({
    store: rig.store,
    files: rig.files,
    reader: { read },
    mapping: rig.mapping,
    access: { require: () => Promise.resolve(), admit: () => undefined, readable: () => Promise.resolve([]) },
    policy: { authorizeSource: () => Promise.resolve({ allowed: true }) },
    policyVersion: () => 'none',
    audit,
    refusalAudit,
    logger: { warn: () => undefined },
  });
  return { exports, rig, id: opened.id };
}

describe.each([[request], [{ ...request, mask: true }]])('an export that the client abandons (%j)', (asked) => {
  it('leaves no row and no file when the client aborts during the reads', async () => {
    const { exports, rig, id } = await service(() => Promise.reject(new RequestCancelled()));
    await expect(exports.create({ traceId: 't', principal: principalFixture, investigationId: id, request: asked })).rejects.toBeInstanceOf(RequestCancelled);
    expect(rig.store.exports.rows).toEqual([]);
    expect(await rig.files.list()).toEqual([]);
    await rig.stop();
  });

  it('marks the row failed and leaves no file and no temporary file when the client aborts before the write', async () => {
    const controller = new AbortController();
    const { exports, rig, id } = await service(() => {
      controller.abort();
      return Promise.resolve(EMPTY);
    });
    await expect(exports.create({ traceId: 't', principal: principalFixture, investigationId: id, request: asked, signal: controller.signal })).rejects.toMatchObject({ code: 'EXPORT_FAILED' });
    expect(rig.store.exports.rows).toMatchObject([{ status: 'failed', storageKey: null }]);
    expect(await rig.files.list()).toEqual([]);
    await rig.stop();
  });
});

describe('an export whose masked read fails', () => {
  it.each([['QUERY_TIMEOUT'], ['SOURCE_BUSY'], ['SOURCE_UNAVAILABLE']] as const)('keeps nothing and answers the gate\'s own %s', async (code) => {
    const { exports, rig, id } = await service(() => Promise.reject(new AppError(code)));
    await expect(exports.create({ traceId: 't', principal: principalFixture, investigationId: id, request: { ...request, mask: true } })).rejects.toMatchObject({ code });
    expect(rig.store.exports.rows).toEqual([]);
    expect(await rig.files.list()).toEqual([]);
    await rig.stop();
  });
});

describe('an export of an investigation whose source changed', () => {
  it.each([
    ['repointed', { sourceIdentityHash: 'another-database' }],
    ['removed', { sourceId: 'gone' }],
  ] as const)('is refused as source-changed (%s), reads nothing and keeps nothing', async (sourceState, change) => {
    const rig = await startExportRig();
    const opened = await rig.open();
    const [row] = rig.store.investigations;
    if (row === undefined) throw new Error('no investigation');
    rig.store.investigations[0] = { ...row, ...change };
    const readsBefore = rig.executor.calls.length;
    const response = await rig.create(opened.id, request);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: 'CONFLICT', details: { reason: 'source-changed', sourceState } });
    expect(rig.store.exports.rows).toEqual([]);
    expect(await rig.files.list()).toEqual([]);
    expect(rig.executor.calls.length).toBe(readsBefore);
    await rig.stop();
  });
});

describe('the path of the events of an export', () => {
  it('writes the event of a created export through the direct member and none through the queued one, and the event of a refusal the other way round', async () => {
    const direct: string[] = [];
    const queued: string[] = [];
    const { exports, rig, id } = await service(
      () => Promise.resolve(EMPTY),
      { record: (event) => (direct.push(`${event.action}:${event.result}`), Promise.resolve()) },
      { record: (event) => (queued.push(`${event.action}:${event.result}`), Promise.resolve()) },
    );
    await exports.create({ traceId: 't', principal: principalFixture, investigationId: id, request });
    expect(direct).toEqual(['export.create:success']);
    expect(queued).toEqual([]);
    await expect(exports.create({ traceId: 't', principal: principalFixture, investigationId: id, request: { ...request, summaryToken: 'not-a-token' } })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(direct).toEqual(['export.create:success']);
    expect(queued).toEqual(['export.create:refused']);
    await rig.stop();
  });
});

describe('a file made from a read in which a policy masks a property', () => {
  const policy = { key: 'holder', value: 'J••• L•••', dataClass: 'name' as const, masked: true, maskedBy: 'policy' as const };
  const policyRead = (): Awaited<ReturnType<ShownReader['read']>> => ({
    ...EMPTY,
    nodes: [{ ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, display: { title: 'J••• L•••', type: 'Widget' }, properties: [policy], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } }],
    maskedFields: 1,
  });

  it.each([
    ['json', undefined],
    ['json', false],
    ['json', true],
    ['csv', undefined],
    ['csv', false],
    ['csv', true],
  ] as const)('keeps the masked value, the policy marker and the count in the stored %s file when the flag is %s', async (format, flag) => {
    const asked: unknown[] = [];
    const { exports, rig, id } = await service((call) => (asked.push(call), Promise.resolve(policyRead())));
    await exports.create({ traceId: 't', principal: principalFixture, investigationId: id, request: { ...request, format, ...(flag === undefined ? {} : { mask: flag }) } });
    const [row] = rig.store.exports.rows;
    const bytes = await rig.files.read(row?.storageKey ?? '');
    expect(asked[0]).toMatchObject(flag === undefined ? {} : { mask: flag });
    expect(row).toMatchObject({ masked: true, maskedFieldCount: 1 });
    const folder = mkdtempSync(join(tmpdir(), 'nbx-policy-zip-'));
    writeFileSync(join(folder, 'x.zip'), bytes ?? '');
    const text = format === 'json' ? (bytes?.toString('utf8') ?? '') : execFileSync('unzip', ['-p', join(folder, 'x.zip'), 'entities.csv'], { encoding: 'utf8' });
    expect(text).toContain('masking: 1 critical fields masked');
    expect(text).toContain('J••• L•••');
    if (format === 'json') expect(JSON.parse(text).entities[0].properties[0]).toMatchObject({ value: 'J••• L•••', masked: true, maskedBy: 'policy' });
    await rig.stop();
  });
});
