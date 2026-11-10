import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExportRequest } from '@neburyx/contracts';
import { RequestCancelled } from '../errors.js';
import { exportWebRoot, startExportRig } from '../testing/export-rig.js';
import { principalFixture } from '../testing/principal-fixture.js';
import { createExportService } from './export-service.js';
import type { ShownReader } from './shown-reader.js';

afterAll(() => rmSync(exportWebRoot, { recursive: true, force: true }));

const EMPTY = { nodes: [], edges: [], omitted: false, maskedFields: 0, notRetrieved: { value: 0, quality: 'exact' as const, scope: 'not yet retrieved' } };
const request: ExportRequest = { kind: 'view', format: 'json', entities: [], edges: [], aggregates: [], derived: [] };

async function service(read: ShownReader['read']) {
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
    audit: { record: () => Promise.resolve() },
    logger: { warn: () => undefined },
  });
  return { exports, rig, id: opened.id };
}

describe('an export that the client abandons', () => {
  it('leaves no row and no file when the client aborts during the reads', async () => {
    const { exports, rig, id } = await service(() => Promise.reject(new RequestCancelled()));
    await expect(exports.create({ traceId: 't', principal: principalFixture, investigationId: id, request })).rejects.toBeInstanceOf(RequestCancelled);
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
    await expect(exports.create({ traceId: 't', principal: principalFixture, investigationId: id, request, signal: controller.signal })).rejects.toMatchObject({ code: 'EXPORT_FAILED' });
    expect(rig.store.exports.rows).toMatchObject([{ status: 'failed', storageKey: null }]);
    expect(await rig.files.list()).toEqual([]);
    await rig.stop();
  });
});
