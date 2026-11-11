import { readdirSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expireExports, purgeDeletedInvestigations } from '../../../services/api/src/jobs/maintenance.js';
import { createLogger } from '../../../services/api/src/logger.js';
import { startPostgres, type TestPostgres } from '../../../services/api/src/testing/postgres.js';
import { downloaded, made, removeExportFolder, reopened, viewRequest } from './export-helpers.js';
import { closePgStores, startPgSuite, type PgSuite } from './rig.js';

let postgres: TestPostgres;
let suite: PgSuite | undefined;
beforeAll(async () => {
  postgres = await startPostgres();
});
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});
afterAll(async () => {
  removeExportFolder();
  await closePgStores();
  await postgres.stop();
});

const NOT_FOUND = { ok: false, failure: { code: 'NOT_FOUND' } };
const silent = createLogger({ write: () => undefined });
const maintenance = (running: PgSuite) => ({ store: running.store, exports: running.store, files: running.exportFiles, audit: { record: () => Promise.resolve() }, logger: silent });
const withoutTrace = (answer: { readonly ok: boolean; readonly failure?: object }) => {
  const { traceId: _trace, ...rest } = (answer.failure ?? {}) as { traceId?: string };
  return rest;
};
const files = (running: PgSuite): string[] => readdirSync(running.exportDirectory);
const exportRows = (running: PgSuite) => running.sql(`SELECT status, storage_key, investigation_id FROM exports ORDER BY created_at`);

describe('exports on real Postgres', () => {
  it('writes a row and a file for each export, and past its expiry the task removes the file, clears the row and a download answers NOT_FOUND', async () => {
    suite = await startPgSuite(postgres);
    const { tab, id } = await reopened(suite);
    const json = await made(tab, id, 'json', viewRequest(tab, 'json'));
    const csv = await made(tab, id, 'csv', viewRequest(tab, 'csv'));
    expect((await exportRows(suite)).map((row) => row['status'])).toEqual(['ready', 'ready']);
    expect(files(suite)).toHaveLength(2);

    expect(await expireExports(maintenance(suite))).toMatchObject({ expired: 0 });
    expect(files(suite)).toHaveLength(2);

    await suite.sql(`UPDATE exports SET expires_at = now() - interval '1 second'`);
    expect(await expireExports(maintenance(suite))).toMatchObject({ expired: 2, unnamedFiles: 0 });
    expect(files(suite)).toEqual([]);
    expect(await exportRows(suite)).toEqual([expect.objectContaining({ status: 'expired', storage_key: null }), expect.objectContaining({ status: 'expired', storage_key: null })]);
    const unknown = await tab.client.downloadExport('3b5a0f8e-1c2d-4e6f-8a9b-0c1d2e3f4a5b');
    expect(unknown).toMatchObject(NOT_FOUND);
    for (const record of [json.record, csv.record]) {
      const answer = await tab.client.downloadExport(record.id);
      expect(answer).toMatchObject(NOT_FOUND);
      expect(withoutTrace(answer)).toEqual(withoutTrace(unknown));
    }
    expect(await expireExports(maintenance(suite))).toMatchObject({ expired: 0 });
  });

  it('keeps the exports of a deleted investigation, brings the same files back when it is restored, and the purge removes their rows and their files with the investigation', async () => {
    suite = await startPgSuite(postgres);
    const { tab, id } = await reopened(suite);
    const kept = await made(tab, id, 'json', viewRequest(tab, 'json'));
    await made(tab, id, 'csv', viewRequest(tab, 'csv'));
    const bytes = await downloaded(tab, kept.record.id);
    const versionOf = async () => {
      const read = await tab.client.getInvestigation(id);
      return read.ok ? read.value.investigation.version : 0;
    };
    const deleted = await tab.client.deleteInvestigation(id, await versionOf());
    if (!deleted.ok) throw new Error('the investigation was deleted');
    expect(await tab.client.downloadExport(kept.record.id)).toMatchObject(NOT_FOUND);
    expect(await purgeDeletedInvestigations(maintenance(suite))).toBe(0);
    expect(files(suite)).toHaveLength(2);
    expect(await exportRows(suite)).toHaveLength(2);

    expect(await tab.client.restoreInvestigation(id, deleted.value.version)).toMatchObject({ ok: true });
    expect(await downloaded(tab, kept.record.id)).toEqual(bytes);

    const again = await tab.client.deleteInvestigation(id, await versionOf());
    expect(again).toMatchObject({ ok: true });
    await suite.sql(`UPDATE investigations SET purge_after = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await purgeDeletedInvestigations(maintenance(suite))).toBe(1);
    expect(files(suite)).toEqual([]);
    expect(await exportRows(suite)).toEqual([]);
    expect(await tab.client.downloadExport(kept.record.id)).toMatchObject(NOT_FOUND);
  });
});
