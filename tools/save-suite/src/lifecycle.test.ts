import { afterEach, describe, expect, it } from 'vitest';
import { saveNamedView } from '../../../apps/web/src/views/save-view.js';
import { AUTOSAVE_DELAY_MS, ref, startSuite, type Suite, type Tab } from './rig.js';

let suite: Suite | undefined;
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});

const NOT_FOUND = { ok: false, failure: { code: 'NOT_FOUND' } };
const READ_ONLY = { ok: false, failure: { code: 'CONFLICT', details: { reason: 'investigation-read-only' } } };
const move = (tab: Tab, x: number) => tab.state.presentation.setPositions(new Map([[tab.nodeKey('leaf', 'L-1'), { x, y: x }]]));

async function started(running: Suite): Promise<{ readonly tab: Tab; readonly id: string }> {
  const tab = running.tab();
  await tab.open(ref('hub', 'H-1'), 'CASE-1');
  const id = tab.state.investigation.getState().id ?? '';
  await tab.load([ref('leaf', 'L-1'), ref('leaf', 'L-2')]);
  move(tab, 30);
  await running.advance(AUTOSAVE_DELAY_MS);
  await tab.written();
  return { tab, id };
}

const versionOf = async (tab: Tab, id: string): Promise<number> => {
  const read = await tab.client.getInvestigation(id);
  if (!read.ok) throw new Error('the investigation was read');
  return read.value.investigation.version;
};

describe('closing, archiving and reopening', () => {
  it.each(['closed', 'archived'] as const)('refuses draft and view writes while %s, shows the state in the record, and accepts writes again after a reopen', async (status) => {
    suite = await startSuite();
    const { tab, id } = await started(suite);
    expect(await tab.client.changeInvestigationStatus(id, status, await versionOf(tab, id))).toMatchObject({ ok: true });
    move(tab, 31);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await suite.until(() => tab.state.investigation.getState().record?.status === status, `the ${status} record`);
    expect(tab.state.investigation.getState().record).toMatchObject({ readOnly: true, status });
    expect(await tab.client.saveView(id, suite.draft()?.version ?? 1, { name: 'Late', notes: null })).toMatchObject(READ_ONLY);
    expect(suite.draft()?.layout.nodes.find((node) => node.id === 'L-1')).toMatchObject({ x: 30 });

    expect(await tab.client.changeInvestigationStatus(id, 'open', await versionOf(tab, id))).toMatchObject({ ok: true });
    const fresh = suite.tab();
    await fresh.openById(id);
    expect(fresh.state.investigation.getState().record).toMatchObject({ readOnly: false, status: 'open' });
    move(fresh, 40);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await fresh.written();
    expect(suite.draft()?.layout.nodes.find((node) => node.id === 'L-1')).toMatchObject({ x: 40 });
  });

  it('refuses a stale expected version of a status change', async () => {
    suite = await startSuite();
    const { tab, id } = await started(suite);
    const before = await tab.client.getInvestigation(id);
    expect(await tab.client.changeInvestigationStatus(id, 'closed', 99)).toMatchObject({ ok: false, failure: { code: 'CONFLICT' } });
    const after = await tab.client.getInvestigation(id);
    expect(after).toMatchObject({ ok: true, value: { investigation: { status: 'open' } } });
    expect(after.ok && after.value.investigation.version).toBe(before.ok && before.value.investigation.version);
  });
});

describe('a deleted investigation before its purge date', () => {
  it('answers NOT_FOUND on every route but restore, is listed only as deleted with its purge date, and restores with its draft, views and status', async () => {
    suite = await startSuite();
    const { tab, id } = await started(suite);
    expect(await saveNamedView(tab.client, tab.state, { name: 'Keep me', notes: 'a note' })).toEqual({ kind: 'saved' });
    expect(await tab.client.changeInvestigationStatus(id, 'closed', await versionOf(tab, id))).toMatchObject({ ok: true });
    const canonical = tab.canonical();
    const draft = structuredClone(suite.draft());
    const version = await versionOf(tab, id);
    const deleted = await tab.client.deleteInvestigation(id, version);
    expect(deleted).toMatchObject({ ok: true });
    const afterDelete = deleted.ok ? deleted.value.version : 0;

    expect(await tab.client.getInvestigation(id)).toMatchObject(NOT_FOUND);
    expect(await tab.client.listViews(id, {})).toMatchObject(NOT_FOUND);
    expect(await tab.client.createExport(id, { kind: 'view', format: 'json', entities: [], edges: [], aggregates: [], derived: [] }, 'lifecycle-export-0001-key')).toMatchObject(NOT_FOUND);
    expect(await tab.client.renameInvestigation(id, 'Late', version)).toMatchObject(NOT_FOUND);
    expect(await tab.client.changeInvestigationStatus(id, 'open', version)).toMatchObject(NOT_FOUND);
    expect(await tab.client.saveDraft(id, draft?.version ?? 1, { notes: null, layout: draft?.layout, queryContext: draft?.queryContext } as Parameters<Tab['client']['saveDraft']>[2])).toMatchObject(NOT_FOUND);
    const live = await tab.client.listInvestigationPage({});
    expect(live.ok && live.value.items.map((item) => item.id)).toEqual([]);
    const gone = await tab.client.listInvestigationPage({ deleted: true });
    expect(gone.ok && gone.value.items.map((item) => item.id)).toEqual([id]);
    expect(gone.ok && gone.value.items[0]).toHaveProperty('purgeAfter');

    expect(await tab.client.restoreInvestigation(id, afterDelete)).toMatchObject({ ok: true });
    const fresh = suite.tab();
    await fresh.openById(id);
    expect(fresh.canonical()).toBe(canonical);
    expect(fresh.state.investigation.getState().record).toMatchObject({ status: 'closed', readOnly: true });
    expect(suite.draft()).toEqual(draft);
    expect(await fresh.client.listViews(id, {})).toMatchObject({ ok: true, value: { items: [{ name: 'Keep me' }] } });
  });

  it('answers NOT_FOUND to a delete or a restore of an unknown id, of an investigation that is not deleted, and of one that belongs to someone else', async () => {
    suite = await startSuite();
    const { tab, id } = await started(suite);
    const version = await versionOf(tab, id);
    expect(await tab.client.deleteInvestigation('0192f000-0000-7000-8000-0000000000ee', 1)).toMatchObject(NOT_FOUND);
    expect(await tab.client.restoreInvestigation('0192f000-0000-7000-8000-0000000000ee', 1)).toMatchObject(NOT_FOUND);
    expect(await tab.client.restoreInvestigation(id, version)).toMatchObject(NOT_FOUND);
    const mine = suite.store.investigations[0];
    if (mine === undefined) throw new Error('the investigation was stored');
    const theirs = { ...mine, id: '0192f000-0000-7000-8000-0000000000dd', ownerId: '0192f000-0000-7000-8000-0000000000cc' };
    suite.store.investigations.push(theirs);
    expect(await tab.client.deleteInvestigation(theirs.id, theirs.version)).toMatchObject(NOT_FOUND);
    expect(await tab.client.restoreInvestigation(theirs.id, theirs.version)).toMatchObject(NOT_FOUND);
    expect(await tab.client.getInvestigation(theirs.id)).toMatchObject(NOT_FOUND);
  });
});
