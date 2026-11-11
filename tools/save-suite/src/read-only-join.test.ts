import { afterEach, describe, expect, it } from 'vitest';
import { saveNamedView } from '../../../apps/web/src/views/save-view.js';
import { AUTOSAVE_DELAY_MS, ref, startSuite, type Suite, type Tab } from './rig.js';

let suite: Suite | undefined;
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});

const writes = (tab: Tab) => tab.draftWrites();
const READ_ONLY = { ok: false, failure: { code: 'CONFLICT', details: { reason: 'investigation-read-only' } } };

async function twoTabsWithAView(running: Suite) {
  const a = running.tab();
  await a.open(ref('hub', 'H-1'));
  const id = a.state.investigation.getState().id ?? '';
  await a.load([ref('leaf', 'L-1')]);
  await running.advance(AUTOSAVE_DELAY_MS);
  await a.written();
  expect(await saveNamedView(a.client, a.state, { name: 'Before', notes: 'a note' })).toEqual({ kind: 'saved' });
  const viewId = running.store.namedViews[0]?.id ?? '';
  const b = running.tab();
  await b.openById(id);
  return { a, b, id, viewId };
}

/** Changes the status as the second tab would: from the investigation's version as the server holds it now. */
async function changeStatus(tab: Tab, id: string, status: 'open' | 'closed' | 'archived') {
  const current = await tab.client.getInvestigation(id);
  const result = await tab.client.changeInvestigationStatus(id, status, current.ok ? current.value.investigation.version : 0);
  expect(result).toMatchObject({ ok: true });
  return result;
}

const move = (tab: Tab, x: number) => tab.state.presentation.setPositions(new Map([[tab.nodeKey('leaf', 'L-1'), { x, y: x }]]));

describe.each(['closed', 'archived'] as const)('an investigation %s in another tab', (status) => {
  it('refuses every write of the first tab with investigation-read-only, stores nothing, and puts the first tab in the read-only state', async () => {
    suite = await startSuite();
    const { a, b, id, viewId } = await twoTabsWithAView(suite);
    await changeStatus(b, id, status);
    const stored = structuredClone({ draft: suite.draft(), views: suite.store.namedViews });
    const version = suite.draft()?.version ?? 1;

    expect(await a.client.saveView(id, version, { name: 'After', notes: null })).toMatchObject(READ_ONLY);
    expect(await a.client.restoreView(id, viewId, version)).toMatchObject(READ_ONLY);
    expect(await a.client.renameView(id, viewId, 1, 'Renamed')).toMatchObject(READ_ONLY);
    expect(await a.client.deleteView(id, viewId, 1, null)).toMatchObject(READ_ONLY);
    move(a, 55);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await suite.until(() => a.state.investigation.getState().record?.readOnly === true, 'the first tab to read as read-only');
    expect(a.sync.status.getState().kind).toBe('idle');
    expect(a.state.investigation.getState().record).toMatchObject({ readOnly: true, status });
    expect({ draft: suite.draft(), views: suite.store.namedViews }).toEqual(stored);
    expect(writes(a)).toHaveLength(2);
    move(a, 66);
    await suite.advance(AUTOSAVE_DELAY_MS * 4);
    expect(writes(a)).toHaveLength(2);
  });

  it('shows the same refusal for the web\'s own save of a view, and accepts the first tab\'s next write once the investigation is reopened and opened again', async () => {
    suite = await startSuite();
    const { a, b, id } = await twoTabsWithAView(suite);
    await changeStatus(b, id, status);
    expect(await saveNamedView(a.client, a.state, { name: 'After', notes: null })).toEqual({ kind: 'failed' });
    expect(a.state.investigation.getState().record).toMatchObject({ readOnly: true });
    await changeStatus(b, id, 'open');
    const fresh = suite.tab();
    expect(await fresh.openById(id)).toMatchObject({ kind: 'shown', id });
    expect(fresh.state.investigation.getState().record).toMatchObject({ readOnly: false, status: 'open' });
    await fresh.load([ref('leaf', 'L-2')]);
    move(fresh, 9);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await fresh.written();
    expect(suite.draft()?.layout.nodes.find((node) => node.id === 'L-1')).toMatchObject({ x: 9, y: 9 });
  });
});

describe('a draft write sent after the close', () => {
  it('is refused and the stored draft is the write before the close (the write in flight during a close is proved on Postgres)', async () => {
    suite = await startSuite();
    const { a, b, id } = await twoTabsWithAView(suite);
    move(a, 20);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await a.written();
    const before = structuredClone(suite.draft());
    await changeStatus(b, id, 'closed');
    move(a, 30);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await suite.until(() => a.state.investigation.getState().record?.readOnly === true);
    expect(suite.draft()).toEqual(before);
  });
});
