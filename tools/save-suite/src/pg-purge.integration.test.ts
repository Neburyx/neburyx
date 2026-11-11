import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { saveNamedView } from '../../../apps/web/src/views/save-view.js';
import { purgeDeletedInvestigations } from '../../../services/api/src/jobs/maintenance.js';
import { createLogger } from '../../../services/api/src/logger.js';
import { startPostgres, type TestPostgres } from '../../../services/api/src/testing/postgres.js';
import { closePgStores, ref, startPgSuite, type PgSuite, type Tab } from './rig.js';
import { arranged } from './scenarios.js';

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
  await closePgStores();
  await postgres.stop();
});

const NOT_FOUND = { ok: false, failure: { code: 'NOT_FOUND' } };
const silent = createLogger({ write: () => undefined });
const purge = (running: PgSuite) => purgeDeletedInvestigations({ store: running.store, exports: running.store, files: running.exportFiles, audit: { record: () => Promise.resolve() }, logger: silent });
const idsOf = async (tab: Tab, deleted: boolean) => {
  const page = await tab.client.listInvestigationPage(deleted ? { deleted: true } : {});
  return page.ok ? page.value.items.map((item) => item.id) : [];
};

/** An investigation with a draft and a named view, deleted: its id and the version that restores it. */
async function deletedOne(running: PgSuite): Promise<{ readonly tab: Tab; readonly id: string; readonly version: number }> {
  const { tab, id } = await arranged(running);
  expect(await saveNamedView(tab.client, tab.state, { name: 'Keep me', notes: 'a note' })).toEqual({ kind: 'saved' });
  const read = await tab.client.getInvestigation(id);
  const deleted = await tab.client.deleteInvestigation(id, read.ok ? read.value.investigation.version : 0);
  expect(deleted).toMatchObject({ ok: true });
  return { tab, id, version: deleted.ok ? deleted.value.version : 0 };
}

describe('a deleted investigation and its purge date, on real Postgres', () => {
  it('restores with its draft and views as they were while its purge date is in the future', async () => {
    suite = await startPgSuite(postgres);
    const { tab, id, version } = await deletedOne(suite);
    const draft = await suite.draft();
    await suite.sql(`UPDATE investigations SET purge_after = now() + interval '1 hour' WHERE id = $1`, [id]);
    expect(await idsOf(tab, true)).toEqual([id]);
    expect(await tab.client.restoreInvestigation(id, version)).toMatchObject({ ok: true });
    expect(await suite.draft()).toEqual(draft);
    expect(await tab.client.listViews(id, {})).toMatchObject({ ok: true, value: { items: [{ name: 'Keep me' }] } });
    expect(await idsOf(tab, false)).toEqual([id]);
  });

  it('answers NOT_FOUND to an open and a restore once the purge date has passed, before the purge has run', async () => {
    suite = await startPgSuite(postgres);
    const { tab, id, version } = await deletedOne(suite);
    await suite.sql(`UPDATE investigations SET purge_after = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await tab.client.getInvestigation(id)).toMatchObject(NOT_FOUND);
    expect(await tab.client.restoreInvestigation(id, version)).toMatchObject(NOT_FOUND);
    expect(await idsOf(tab, true)).toEqual([]);
    expect(await suite.sql(`SELECT id FROM investigations WHERE id = $1`, [id])).toHaveLength(1);
  });

  it('removes the investigation, its draft and its views when the purge task has run, and a second run changes nothing', async () => {
    suite = await startPgSuite(postgres);
    const { tab, id } = await deletedOne(suite);
    await suite.sql(`UPDATE investigations SET purge_after = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await purge(suite)).toBe(1);
    expect(await suite.sql(`SELECT id FROM investigations`)).toEqual([]);
    expect(await suite.sql(`SELECT id FROM saved_views`)).toEqual([]);
    expect(await idsOf(tab, true)).toEqual([]);
    expect(await tab.client.getInvestigation(id)).toMatchObject(NOT_FOUND);
    expect(await purge(suite)).toBe(0);
  });

  it('leaves a deleted investigation whose date is in the future, and a live one, when the task runs', async () => {
    suite = await startPgSuite(postgres);
    const first = await deletedOne(suite);
    const expiredId = first.id;
    await suite.sql(`UPDATE investigations SET purge_after = now() - interval '1 day' WHERE id = $1`, [expiredId]);
    const live = suite.tab();
    expect(await live.open(ref('hub', 'H-1'), 'LIVE')).toMatchObject({ kind: 'shown' });
    const liveId = live.state.investigation.getState().id ?? '';
    const waiting = await live.open(ref('hub', 'H-1'), 'WAITING');
    expect(waiting).toMatchObject({ kind: 'shown' });
    const waitingId = live.state.investigation.getState().id ?? '';
    const read = await live.client.getInvestigation(waitingId);
    const gone = await live.client.deleteInvestigation(waitingId, read.ok ? read.value.investigation.version : 0);
    expect(gone).toMatchObject({ ok: true });
    expect(await purge(suite)).toBe(1);
    const left = (await suite.sql(`SELECT id FROM investigations ORDER BY id`)).map((row) => row['id']).sort();
    expect(left).toEqual([liveId, waitingId].sort());
    expect(await idsOf(live, true)).toEqual([waitingId]);
  });
});
