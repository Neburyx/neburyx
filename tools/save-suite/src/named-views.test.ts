import { afterEach, describe, expect, it } from 'vitest';
import { restoreNamedView } from '../../../apps/web/src/views/restore-view.js';
import { saveNamedView } from '../../../apps/web/src/views/save-view.js';
import { AUTOSAVE_DELAY_MS, ref, startSuite, type Suite, type Tab } from './rig.js';

let suite: Suite | undefined;
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});

const NOTE = 'both leaves belong to one supplier';
const DELETION_NOTE = 'saved from the wrong place by mistake';
const READ_ONLY = { ok: false, failure: { code: 'CONFLICT', details: { reason: 'investigation-read-only' } } };
const NOT_FOUND = { ok: false, failure: { code: 'NOT_FOUND' } };

async function withView(running: Suite): Promise<{ readonly tab: Tab; readonly id: string; readonly viewId: string }> {
  const tab = running.tab();
  await tab.open(ref('hub', 'H-1'));
  const id = tab.state.investigation.getState().id ?? '';
  await tab.load([ref('leaf', 'L-1'), ref('leaf', 'L-2')]);
  tab.state.presentation.setPositions(new Map([[tab.nodeKey('leaf', 'L-1'), { x: 40, y: 50 }]]));
  tab.state.presentation.pin([tab.nodeKey('leaf', 'L-1')]);
  expect(await saveNamedView(tab.client, tab.state, { name: 'First view', notes: NOTE })).toEqual({ kind: 'saved' });
  return { tab, id, viewId: running.store.namedViews[0]?.id ?? '' };
}

const move = (tab: Tab, x: number) => tab.state.presentation.setPositions(new Map([[tab.nodeKey('leaf', 'L-1'), { x, y: x }]]));

describe('a named view', () => {
  it('is saved and listed with its name and note, renamed with nothing else changed, and restored into the draft the same before and after the rename', async () => {
    suite = await startSuite();
    const { tab, id, viewId } = await withView(suite);
    const saved = tab.canonical();
    const listed = await tab.client.listViews(id, {});
    expect(listed).toMatchObject({ ok: true, value: { items: [{ id: viewId, name: 'First view', notes: NOTE }], count: { value: 1, quality: 'exact' } } });
    const stored = structuredClone(suite.store.namedViews[0]);
    expect(await tab.client.renameView(id, viewId, 1, 'Renamed view')).toMatchObject({ ok: true, value: { name: 'Renamed view', version: 2 } });
    expect(suite.store.namedViews[0]).toEqual({ ...stored, name: 'Renamed view', version: 2 });

    move(tab, 999);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await tab.written();
    expect(await restoreNamedView(tab.client, tab.state, viewId)).toMatchObject({ kind: 'restored' });
    expect(tab.canonical()).toBe(saved);
    expect(suite.draft()?.notes).toBe(NOTE);
  });

  it('is refused its stale If-Match and its unknown id without a change', async () => {
    suite = await startSuite();
    const { tab, id, viewId } = await withView(suite);
    expect(await tab.client.renameView(id, '0192f000-0000-7000-8000-0000000000ff', 1, 'Nothing')).toMatchObject(NOT_FOUND);
    expect(await tab.client.renameView(id, viewId, 7, 'Stale')).toMatchObject({ ok: false, failure: { code: 'CONFLICTED_VIEW_VERSION' } });
    expect(suite.store.namedViews.map((view) => view.name)).toEqual(['First view']);
  });
});

describe('a named view that was deleted with a note', () => {
  it('is left out of every read, answers NOT_FOUND to a rename, a restore and a second delete, and leaves the investigation unsaved', async () => {
    suite = await startSuite();
    const { tab, id, viewId } = await withView(suite);
    expect(await tab.client.getInvestigation(id)).toMatchObject({ ok: true, value: { save: { state: 'saved' } } });
    expect(await tab.client.listOwnedViews({})).toMatchObject({ ok: true, value: { count: { value: 1 } } });
    expect(await tab.client.deleteView(id, viewId, 1, DELETION_NOTE)).toMatchObject({ ok: true });

    expect(await tab.client.listViews(id, {})).toMatchObject({ ok: true, value: { items: [], count: { value: 0 } } });
    expect(await tab.client.listOwnedViews({})).toMatchObject({ ok: true, value: { items: [], count: { value: 0 } } });
    expect(await tab.client.renameView(id, viewId, 1, 'Back again')).toMatchObject(NOT_FOUND);
    expect(await tab.client.restoreView(id, viewId, suite.draft()?.version ?? 1)).toMatchObject(NOT_FOUND);
    expect(await tab.client.deleteView(id, viewId, 1, null)).toMatchObject(NOT_FOUND);
    expect(await tab.client.getInvestigation(id)).toMatchObject({ ok: true, value: { save: { state: 'unsaved' } } });
    expect(suite.store.namedViews[0]).toMatchObject({ deletionNote: DELETION_NOTE });
  });

  it('shows its deletion note and its id in no response of any route after the delete, and cannot be restored after any later change', async () => {
    suite = await startSuite();
    const { tab, id, viewId } = await withView(suite);
    expect(await tab.client.deleteView(id, viewId, 1, DELETION_NOTE)).toMatchObject({ ok: true });
    const after = tab.bodies.length;

    await tab.client.listViews(id, {});
    await tab.client.listOwnedViews({});
    await tab.client.getInvestigation(id);
    await tab.client.listInvestigationPage({});
    await tab.client.renameView(id, viewId, 1, 'x');
    await tab.client.restoreView(id, viewId, 1);
    move(tab, 5);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await tab.written();
    expect(await tab.client.restoreView(id, viewId, suite.draft()?.version ?? 1)).toMatchObject(NOT_FOUND);
    const seen = tab.bodies.slice(after).join('\n');
    expect(seen).not.toContain(DELETION_NOTE);
    expect(seen).not.toContain(viewId);
  });
});

describe.each(['closed', 'archived'] as const)('a named view of an investigation that is %s', (status) => {
  it('is saved, renamed, restored and deleted by no one: each is refused with investigation-read-only and nothing changes', async () => {
    suite = await startSuite();
    const { tab, id, viewId } = await withView(suite);
    const current = await tab.client.getInvestigation(id);
    expect(await tab.client.changeInvestigationStatus(id, status, current.ok ? current.value.investigation.version : 0)).toMatchObject({ ok: true });
    const stored = structuredClone({ draft: suite.draft(), views: suite.store.namedViews });
    const version = suite.draft()?.version ?? 1;
    expect(await tab.client.saveView(id, version, { name: 'Late', notes: null })).toMatchObject(READ_ONLY);
    expect(await tab.client.renameView(id, viewId, 1, 'Late')).toMatchObject(READ_ONLY);
    expect(await tab.client.restoreView(id, viewId, version)).toMatchObject(READ_ONLY);
    expect(await tab.client.deleteView(id, viewId, 1, null)).toMatchObject(READ_ONLY);
    expect({ draft: suite.draft(), views: suite.store.namedViews }).toEqual(stored);
  });
});
