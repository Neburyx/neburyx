import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { purgeDeletedInvestigations } from '../jobs/maintenance.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { holdRow } from '../testing/barrier.js';
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

type Rig = Awaited<ReturnType<typeof startRig>>;
const running = () => startRig(postgres, mapping);
const silent = createLogger({ write: () => undefined });
const purgeWith = (rig: Rig, audited: string[] = []) => purgeDeletedInvestigations({ store: rig.store, audit: { record: (event) => { audited.push(event.action); return Promise.resolve(); } }, logger: silent });

/** An investigation with a view, deleted, with its purge date `purgeAfter` (an interval from the database's now). */
async function deleted(rig: Rig, caseRef: string, purgeAfter: string | null): Promise<string> {
  const opened = await rig.open(caseRef);
  const id = opened.investigation.id;
  await rig.saveView(id, opened.draft.version);
  expect((await rig.removeInvestigation(id, 1)).statusCode).toBe(200);
  if (purgeAfter !== null) await rows(rig.database.ownerUrl, `UPDATE investigations SET purge_after = now() + $2::interval WHERE id = $1`, [id, purgeAfter]);
  return id;
}

const tablesOtherThanInvestigations = async (rig: Rig): Promise<string> => {
  const tables = await rows(rig.database.ownerUrl, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT IN ('investigations', 'saved_views') ORDER BY table_name`);
  const contents = await Promise.all(tables.map(async (table) => [table['table_name'], await rows(rig.database.ownerUrl, `SELECT * FROM "${String(table['table_name'])}" ORDER BY 1`)]));
  return JSON.stringify(contents);
};

describe('purging expired investigations against Postgres', () => {
  it('deletes each expired investigation with its draft and its views, deleted ones included, and writes one event for each', async () => {
    const rig = await running();
    const first = await deleted(rig, 'A', "-1 second");
    const second = await deleted(rig, 'B', "-2 days");
    const opened = await rig.open('C');
    const kept = await rig.saveView(opened.investigation.id, opened.draft.version);
    const audited: string[] = [];
    expect(await purgeWith(rig, audited)).toBe(2);
    expect(audited).toEqual(['investigation.purge', 'investigation.purge']);
    expect(await rows(rig.database.ownerUrl, `SELECT id FROM investigations WHERE id = ANY($1)`, [[first, second]])).toEqual([]);
    expect(await rows(rig.database.ownerUrl, `SELECT id FROM saved_views WHERE investigation_id = ANY($1)`, [[first, second]])).toEqual([]);
    expect((await rows(rig.database.ownerUrl, `SELECT id FROM saved_views WHERE id = $1`, [kept.view.id])).length).toBe(1);
    await rig.app.close();
  });

  it('removes a view that was deleted on its own together with its investigation', async () => {
    const rig = await running();
    const opened = await rig.open('A');
    const id = opened.investigation.id;
    const saved = await rig.saveView(id, opened.draft.version);
    expect((await rig.removeView(id, saved.view.id, 1, 'the note')).statusCode).toBe(200);
    expect((await rig.removeInvestigation(id, 1)).statusCode).toBe(200);
    await rows(rig.database.ownerUrl, `UPDATE investigations SET purge_after = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await purgeWith(rig)).toBe(1);
    expect(await rows(rig.database.ownerUrl, `SELECT id FROM saved_views`)).toEqual([]);
    await rig.app.close();
  });

  it('touches nothing else: live investigations, ones whose date is ahead, and every other table', async () => {
    const rig = await running();
    const live = await rig.open('LIVE');
    await rig.saveView(live.investigation.id, live.draft.version);
    const ahead = await deleted(rig, 'AHEAD', '1 day');
    await deleted(rig, 'GONE', '-1 second');
    const before = { others: await tablesOtherThanInvestigations(rig), live: await rows(rig.database.ownerUrl, `SELECT * FROM investigations WHERE id = ANY($1) ORDER BY id`, [[live.investigation.id, ahead]]), views: await rows(rig.database.ownerUrl, `SELECT * FROM saved_views WHERE investigation_id = ANY($1) ORDER BY id`, [[live.investigation.id, ahead]]) };
    expect(await purgeWith(rig)).toBe(1);
    expect(await tablesOtherThanInvestigations(rig)).toBe(before.others);
    expect(await rows(rig.database.ownerUrl, `SELECT * FROM investigations WHERE id = ANY($1) ORDER BY id`, [[live.investigation.id, ahead]])).toEqual(before.live);
    expect(await rows(rig.database.ownerUrl, `SELECT * FROM saved_views WHERE investigation_id = ANY($1) ORDER BY id`, [[live.investigation.id, ahead]])).toEqual(before.views);
    await rig.app.close();
  });

  it('purges more than one pass of 100 until none is left', async () => {
    const rig = await running();
    const seed = await deleted(rig, 'SEED', '-1 second');
    await rows(rig.database.ownerUrl, `INSERT INTO investigations (id, source_id, source_identity_hash, owner_id, title, deleted_at, purge_after, deleted_by)
      SELECT gen_random_uuid(), source_id, source_identity_hash, owner_id, 'Bulk ' || n, now() - interval '2 days', now() - interval '1 second', owner_id FROM investigations, generate_series(1, 104) AS n WHERE id = $1`, [seed]);
    expect((await rows(rig.database.ownerUrl, `SELECT count(*)::int AS n FROM investigations`))[0]?.['n']).toBe(105);
    expect(await purgeWith(rig)).toBe(105);
    expect(await rows(rig.database.ownerUrl, `SELECT id FROM investigations`)).toEqual([]);
    await rig.app.close();
  });

  it('deletes nothing on a second run, and counts every one once when two runs start together', async () => {
    const rig = await running();
    for (const caseRef of ['A', 'B', 'C', 'D', 'E', 'F']) await deleted(rig, caseRef, '-1 second');
    const [one, other] = await Promise.all([purgeWith(rig), purgeWith(rig)]);
    expect(one + other).toBe(6);
    expect(await rows(rig.database.ownerUrl, `SELECT id FROM investigations`)).toEqual([]);
    expect(await purgeWith(rig)).toBe(0);
    await rig.app.close();
  });

  it('keeps an investigation whose event the audit sink rejects, stops there, raises, and keeps what was purged before it', async () => {
    const rig = await running();
    for (const caseRef of ['A', 'B', 'C']) await deleted(rig, caseRef, '-1 second');
    let seen = 0;
    const failing = purgeDeletedInvestigations({ store: rig.store, audit: { record: () => (++seen === 2 ? Promise.reject(new Error('the sink is down')) : Promise.resolve()) }, logger: silent });
    await expect(failing).rejects.toThrow('the sink is down');
    expect((await rows(rig.database.ownerUrl, `SELECT id FROM investigations`)).length).toBe(2);
    expect(await purgeWith(rig)).toBe(2);
    await rig.app.close();
  });

  it('leaves a row a restore holds to the next run, and the restore, which began before the purge date, wins', async () => {
    const rig = await running();
    const id = await deleted(rig, 'A', '2 seconds');
    const passed = async () => Number((await rows(rig.database.ownerUrl, `SELECT count(*)::int AS n FROM investigations WHERE id = $1 AND purge_after <= now()`, [id]))[0]?.['n']);
    const held = await holdRow(rig.database, id);
    const restoring = rig.restoreInvestigation(id, 2);
    await held.untilWaiting(1);
    await vi.waitFor(async () => expect(await passed()).toBe(1), { timeout: 10_000, interval: 50 });
    expect(await purgeWith(rig)).toBe(0);
    await held.release();
    expect((await restoring).statusCode).toBe(200);
    expect(await purgeWith(rig)).toBe(0);
    expect((await rows(rig.database.ownerUrl, `SELECT deleted_at FROM investigations WHERE id = $1`, [id]))[0]?.['deleted_at']).toBeNull();
    expect((await rows(rig.database.ownerUrl, `SELECT id FROM saved_views WHERE investigation_id = $1`, [id])).length).toBe(2);
    await rig.app.close();
  });

  it('lets a purge that came first win over a restore, which then finds nothing, and never leaves a restored investigation without its views', async () => {
    const rig = await running();
    const id = await deleted(rig, 'A', '-1 second');
    expect(await purgeWith(rig)).toBe(1);
    expect((await rig.restoreInvestigation(id, 2)).statusCode).toBe(404);
    expect(await rows(rig.database.ownerUrl, `SELECT id FROM investigations`)).toEqual([]);
    expect(await rows(rig.database.ownerUrl, `SELECT id FROM saved_views`)).toEqual([]);
    await rig.app.close();
  });

  it('answers no call and no run with a deadlock when the purge runs beside the writers of an investigation, over and over', async () => {
    const rig = await running();
    const statuses: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      const expired = await deleted(rig, `E${round}`, '-1 second');
      const open = await rig.open(`O${round}`);
      const saved = await rig.saveView(open.investigation.id, open.draft.version);
      const calls = [
        purgeWith(rig).then(() => 200),
        rig.removeView(open.investigation.id, saved.view.id, 1).then((response) => response.statusCode),
        rig.renameView(open.investigation.id, saved.view.id, 1, 'Renamed').then((response) => response.statusCode),
        rig.restoreView(open.investigation.id, saved.view.id, saved.draft.version).then((response) => response.statusCode),
        rig.removeInvestigation(open.investigation.id, 1).then((response) => response.statusCode),
        rig.restoreInvestigation(expired, 2).then((response) => response.statusCode),
      ];
      statuses.push(...(await Promise.all(calls)));
    }
    expect(statuses.filter((status) => status >= 500)).toEqual([]);
    await rig.app.close();
  });
});
