import { rmSync } from 'node:fs';
import type { AuditEvent, AuditSink } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeDeletedInvestigations, removePurgedFiles } from '../jobs/maintenance.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import { idleExportDeps } from '../testing/export-deps.js';
import { rows } from '../testing/database.js';
import { rigStores, startRig } from '../testing/investigation-rig.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { startPostgres, type TestPostgres } from '../testing/postgres.js';
import { webRoot } from '../testing/start-api.js';

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [] })), 'neburyx.yaml');

let postgres: TestPostgres;

beforeAll(async () => {
  postgres = await startPostgres();
});

afterAll(async () => {
  await Promise.all(rigStores.map((store) => store.close()));
  await postgres.stop();
  rmSync(webRoot, { recursive: true, force: true });
});

interface Probe {
  readonly sink: AuditSink;
  failing: boolean;
}

/** A sink that stores its events in a table of the test, through the transaction it is handed, as the Enterprise sink does. */
function probeSink(): Probe {
  const probe: Probe = {
    failing: false,
    sink: {
      async record(event: AuditEvent, options) {
        if (probe.failing) throw new Error('the audit store is down');
        if (options?.transaction === undefined) throw new Error('a privileged event is written through the transaction of its change');
        await options.transaction.query('INSERT INTO audit_probe (action, source_id) VALUES ($1, $2)', [event.action, event.sourceId ?? null]);
      },
    },
  };
  return probe;
}

async function running(probe: Probe) {
  const rig = await startRig(postgres, mapping, { seams: { ...communitySeams(), privilegedAudit: probe.sink } });
  await rows(rig.database.ownerUrl, `CREATE TABLE audit_probe (action text NOT NULL, source_id text)`);
  await rows(rig.database.ownerUrl, `GRANT INSERT, SELECT ON audit_probe TO ${rig.database.appRole}`);
  return rig;
}

type Rig = Awaited<ReturnType<typeof running>>;
const probeActions = async (rig: Rig): Promise<readonly string[]> => (await rows(rig.database.ownerUrl, `SELECT action FROM audit_probe ORDER BY action`)).map((row) => String(row['action']));
const statusOf = async (rig: Rig, id: string) => (await rows(rig.database.ownerUrl, `SELECT status, deleted_at, version FROM investigations WHERE id = $1`, [id]))[0];
const close = (rig: Rig, id: string, version: number) => rig.app.inject({ method: 'POST', url: `/v1/investigations/${id}/status`, headers: { 'content-type': 'application/json' }, payload: { status: 'closed', expectedVersion: version } });

describe('a privileged event and its change against Postgres', () => {
  it('commits the event with a status change, a delete and a restore', async () => {
    const probe = probeSink();
    const rig = await running(probe);
    const opened = await rig.open('A');
    const id = opened.investigation.id;
    expect((await close(rig, id, opened.investigation.version)).statusCode).toBe(200);
    expect((await rig.removeInvestigation(id, opened.investigation.version + 1)).statusCode).toBe(200);
    expect((await rig.restoreInvestigation(id, opened.investigation.version + 2)).statusCode).toBe(200);
    expect(await probeActions(rig)).toEqual(['investigation.close', 'investigation.delete', 'investigation.restore']);
    await rig.app.close();
  });

  it('rolls back a status change, a delete and a restore when the event cannot be written, and leaves no event', async () => {
    const probe = probeSink();
    const rig = await running(probe);
    const opened = await rig.open('A');
    const id = opened.investigation.id;
    const version = opened.investigation.version;
    probe.failing = true;
    expect((await close(rig, id, version)).statusCode).toBe(500);
    expect(await statusOf(rig, id)).toMatchObject({ status: 'open', version });
    expect((await rig.removeInvestigation(id, version)).statusCode).toBe(500);
    expect(await statusOf(rig, id)).toMatchObject({ deleted_at: null, version });
    probe.failing = false;
    expect((await rig.removeInvestigation(id, version)).statusCode).toBe(200);
    probe.failing = true;
    expect((await rig.restoreInvestigation(id, version + 1)).statusCode).toBe(500);
    expect((await statusOf(rig, id))?.['deleted_at']).not.toBeNull();
    expect(await probeActions(rig)).toEqual(['investigation.delete']);
    await rig.app.close();
  });

  it('leaves no event when the transaction fails after the event was inserted', async () => {
    const probe = probeSink();
    const rig = await running(probe);
    const opened = await rig.open('A');
    const id = opened.investigation.id;
    await expect(
      rig.store.deleteInvestigation({
        investigationId: id,
        ownerId: (await rig.store.current()).principal.id,
        expectedVersion: opened.investigation.version,
        retentionDays: 30,
        beforeCommit: async (row, transaction) => {
          await probe.sink.record({ actorId: 'u', actorRole: null, action: 'investigation.delete', result: 'success', traceId: 't', sourceId: row.sourceId }, { transaction });
          throw new Error('the commit did not happen');
        },
      }),
    ).rejects.toThrow('the commit did not happen');
    expect(await probeActions(rig)).toEqual([]);
    expect((await statusOf(rig, id))?.['deleted_at']).toBeNull();
    await rig.app.close();
  });
});

describe('a purge against Postgres', () => {
  async function purgeable(rig: Rig) {
    const opened = await rig.open('A');
    const id = opened.investigation.id;
    const principal = (await rig.store.current()).principal.id;
    await rig.store.insertExport({ id: '0192f000-0000-7000-8000-0000000000e1', investigationId: id, requestedBy: principal, policyVersion: 'none', sourceIdentityHash: 'x', format: 'json', retentionDays: 7 });
    expect((await rig.removeInvestigation(id, opened.investigation.version)).statusCode).toBe(200);
    await rows(rig.database.ownerUrl, `UPDATE investigations SET purge_after = now() - interval '1 second' WHERE id = $1`, [id]);
    return id;
  }

  const purgeWith = (rig: Rig, probe: Probe, files = idleExportDeps().files) =>
    purgeDeletedInvestigations({ store: rig.store, exports: rig.store, files, audit: probe.sink, logger: createLogger({ write: () => undefined }) });

  it('writes the event, the file key and the deletion in one transaction, and removes the file only afterwards, once', async () => {
    const probe = probeSink();
    const rig = await running(probe);
    const id = await purgeable(rig);
    const files = idleExportDeps().files;
    await files.write('0192f000-0000-7000-8000-0000000000e1', Buffer.from('x'));
    expect(await purgeWith(rig, probe, files)).toBe(1);
    expect(await rows(rig.database.ownerUrl, `SELECT id FROM investigations WHERE id = $1`, [id])).toEqual([]);
    expect(await probeActions(rig)).toContain('investigation.purge');
    expect((await rows(rig.database.ownerUrl, `SELECT storage_key FROM file_cleanup`)).map((row) => row['storage_key'])).toEqual(['0192f000-0000-7000-8000-0000000000e1']);
    expect(await files.list()).toHaveLength(1);
    const deps = { store: rig.store, exports: rig.store, files, audit: probe.sink, logger: createLogger({ write: () => undefined }) };
    expect(await removePurgedFiles(deps)).toBe(1);
    expect(await files.list()).toEqual([]);
    expect(await rows(rig.database.ownerUrl, `SELECT storage_key FROM file_cleanup`)).toEqual([]);
    expect(await removePurgedFiles(deps)).toBe(0);
    await rig.app.close();
  });

  it('keeps the investigation, the export and the file, and records no key, when the event cannot be written', async () => {
    const probe = probeSink();
    const rig = await running(probe);
    const id = await purgeable(rig);
    const files = idleExportDeps().files;
    await files.write('0192f000-0000-7000-8000-0000000000e1', Buffer.from('x'));
    probe.failing = true;
    await expect(purgeWith(rig, probe, files)).rejects.toThrow('the audit store is down');
    expect(await rows(rig.database.ownerUrl, `SELECT id FROM investigations WHERE id = $1`, [id])).toHaveLength(1);
    expect(await rows(rig.database.ownerUrl, `SELECT id FROM exports WHERE investigation_id = $1`, [id])).toHaveLength(1);
    expect(await rows(rig.database.ownerUrl, `SELECT storage_key FROM file_cleanup`)).toEqual([]);
    expect(await files.list()).toHaveLength(1);
    await rig.app.close();
  });
});

describe('the table of cleanup records against Postgres', () => {
  it('gives the application role the rights to add and delete a record and read it, and none to change or empty the table', async () => {
    const probe = probeSink();
    const rig = await running(probe);
    const rights = async (right: string): Promise<boolean> => Boolean((await rows(rig.database.ownerUrl, `SELECT has_table_privilege($1, 'public.file_cleanup', $2) AS allowed`, [rig.database.appRole, right]))[0]?.['allowed']);
    expect([await rights('SELECT'), await rights('INSERT'), await rights('DELETE')]).toEqual([true, true, true]);
    expect([await rights('UPDATE'), await rights('TRUNCATE')]).toEqual([false, false]);
    await rig.app.close();
  });
});

describe('the publication of an export against Postgres', () => {
  it('leaves the export pending when the event inserted with it cannot be kept', async () => {
    const probe = probeSink();
    const rig = await running(probe);
    const opened = await rig.open('A');
    const principal = (await rig.store.current()).principal.id;
    const id = '0192f000-0000-7000-8000-0000000000e2';
    await rig.store.insertExport({ id, investigationId: opened.investigation.id, requestedBy: principal, policyVersion: 'none', sourceIdentityHash: 'x', format: 'json', retentionDays: 7 });
    const ready = { filename: 'a.json', storageKey: id, sizeBytes: 1, sha256: 'a'.repeat(64), masked: false, maskedFieldCount: 0 };
    await expect(
      rig.store.completeExport(id, ready, async (transaction) => {
        await probe.sink.record({ actorId: 'u', actorRole: null, action: 'export.create', result: 'success', traceId: 't' }, { transaction });
        throw new Error('the commit did not happen');
      }),
    ).rejects.toThrow('the commit did not happen');
    expect(await probeActions(rig)).toEqual([]);
    expect((await rows(rig.database.ownerUrl, `SELECT status FROM exports WHERE id = $1`, [id]))[0]).toMatchObject({ status: 'pending' });
    await rig.store.completeExport(id, ready, (transaction) => probe.sink.record({ actorId: 'u', actorRole: null, action: 'export.create', result: 'success', traceId: 't' }, { transaction }));
    expect(await probeActions(rig)).toEqual(['export.create']);
    expect((await rows(rig.database.ownerUrl, `SELECT status FROM exports WHERE id = $1`, [id]))[0]).toMatchObject({ status: 'ready' });
    await rig.app.close();
  });
});
