import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expireExports, purgeDeletedInvestigations } from '../../../services/api/src/jobs/maintenance.js';
import { createLogger } from '../../../services/api/src/logger.js';
import { identityHashOf } from '../../../services/api/src/registry/identity-hash.js';
import { reportFromServer } from '../../../services/api/src/source-test/report.js';
import { runCli } from '../../../services/api/src/testing/cli.js';
import { baseSource, fileOf } from '../../../services/api/src/testing/mapping.js';
import { startPostgres, type TestPostgres } from '../../../services/api/src/testing/postgres.js';
import { downloaded, made, removeExportFolder, reopened, viewRequest } from './export-helpers.js';
import { closePgStores, ENTITY_TYPES, mappingOf, RELATIONSHIP_TYPES, SOURCE, startPgSuite, type PgSuite } from './rig.js';

const configFolder = mkdtempSync(join(tmpdir(), 'save-suite-pg-export-'));

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
  rmSync(configFolder, { recursive: true, force: true });
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

  it('records the identity of the source, and refuses the download of an export made before a source was re-pointed even after the real rebind command made the investigation available again', async () => {
    suite = await startPgSuite(postgres);
    const { tab, id } = await reopened(suite);
    const before = await made(tab, id, 'json', viewRequest(tab, 'json'));
    const [original] = mappingOf().sources;
    if (original === undefined) throw new Error('the mapping has a source');
    expect(await suite.sql(`SELECT source_identity_hash FROM exports`)).toEqual([{ source_identity_hash: identityHashOf(original) }]);
    tab.dispose();

    const next = mappingOf({ database: 'a-different-database' });
    await suite.restart(next);
    const [source] = next.sources;
    if (source === undefined) throw new Error('the mapping has a source');
    await suite.store.recordSourceCheck({ id: '0192f000-0000-7000-8000-0000000000a2', report: reportFromServer(source, { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community', versionSupported: true, operations: [] }, false, '2026-11-10T10:00:00.000Z'), triggeredBy: null, identityHash: identityHashOf(source), configHash: source.configHash });
    const file = join(configFolder, 'neburyx.yaml');
    writeFileSync(file, fileOf(baseSource({ id: SOURCE, database: 'a-different-database', entities: ENTITY_TYPES, relationships: RELATIONSHIP_TYPES })));
    const rebound = await runCli(['source', 'rebind', SOURCE, '--confirm', SOURCE], { DATABASE_URL: suite.database.appUrl, NEBURYX_CONFIG: file }).done;
    expect({ code: rebound.code, stdout: rebound.stdout }).toEqual({ code: 0, stdout: 'Source: demo\nInvestigations rebound: 1\n' });

    const again = suite.tab();
    expect(await again.openById(id)).toMatchObject({ kind: 'shown', id });
    expect(again.state.investigation.getState().record).toMatchObject({ readOnly: false, sourceState: 'available' });
    const refused = await again.client.downloadExport(before.record.id);
    expect(refused).toMatchObject({ ok: false, failure: { code: 'ACCESS_DENIED', details: { reason: 'export-source-changed' } } });
    expect(files(suite)).toEqual([]);
    expect(await exportRows(suite)).toEqual([expect.objectContaining({ status: 'expired', storage_key: null })]);
    expect(await again.client.downloadExport(before.record.id)).toMatchObject(NOT_FOUND);

    again.mapTypes(['hub', 'leaf', 'part'], ['LINKED', 'HAS']);
    const fresh = await made(again, id, 'json', viewRequest(again, 'json'));
    expect(fresh.record.id).not.toBe(before.record.id);
    expect(await suite.sql(`SELECT source_identity_hash FROM exports WHERE id = $1`, [fresh.record.id])).toEqual([{ source_identity_hash: identityHashOf(source) }]);
  });

  it('refuses an export that has no recorded identity, as one made before the identity was recorded', async () => {
    suite = await startPgSuite(postgres);
    const { tab, id } = await reopened(suite);
    const old = await made(tab, id, 'json', viewRequest(tab, 'json'));
    await suite.sql(`UPDATE exports SET source_identity_hash = NULL`);
    expect(await tab.client.downloadExport(old.record.id)).toMatchObject({ ok: false, failure: { code: 'ACCESS_DENIED', details: { reason: 'export-source-changed' } } });
    expect(files(suite)).toEqual([]);
  });
});
