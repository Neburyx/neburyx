import { afterEach, describe, expect, it } from 'vitest';
import { AUTOSAVE_DELAY_MS, ref, startSuite, type Suite, type Tab } from './rig.js';

let suite: Suite | undefined;
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});

const writes = (tab: Tab) => tab.draftWrites();
const leaf = (tab: Tab, stableId: string) => tab.nodeKey('leaf', stableId);

/** Two tabs on one investigation, both holding draft version 1 with a leaf loaded. */
async function twoTabs(running: Suite) {
  const a = running.tab();
  await a.open(ref('hub', 'H-1'));
  const id = a.state.investigation.getState().id ?? '';
  await a.load([ref('leaf', 'L-1')]);
  await running.advance(AUTOSAVE_DELAY_MS);
  await a.written();
  const b = running.tab();
  await b.openById(id);
  return { a, b, id };
}

const move = (tab: Tab, x: number) => tab.state.presentation.setPositions(new Map([[leaf(tab, 'L-1'), { x, y: x }]]));

describe('two tabs that write the draft from the same version', () => {
  it('stores one, refuses the other with CONFLICTED_VIEW_VERSION, stops its sync and leaves its canvas as it was', async () => {
    suite = await startSuite();
    const { a, b } = await twoTabs(suite);
    move(a, 100);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await a.written();
    const stored = suite.draft();
    move(b, 200);
    const canvas = b.canonical();
    await suite.advance(AUTOSAVE_DELAY_MS);
    await suite.until(() => b.sync.status.getState().kind === 'conflict', 'the conflict state');
    expect(writes(b)).toHaveLength(1);
    expect(b.canonical()).toBe(canvas);
    expect(suite.draft()).toEqual(stored);
    move(b, 300);
    await suite.advance(AUTOSAVE_DELAY_MS * 4);
    expect(writes(b)).toHaveLength(1);
  });

  it('shows the first tab\'s draft in a fresh client, whose next write carries the new version and is stored', async () => {
    suite = await startSuite();
    const { a, b, id } = await twoTabs(suite);
    move(a, 100);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await a.written();
    move(b, 200);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await suite.until(() => b.sync.status.getState().kind === 'conflict');
    const fresh = suite.tab();
    await fresh.openById(id);
    expect(fresh.state.presentation.view.getState().positions.get(leaf(fresh, 'L-1'))).toEqual({ x: 100, y: 100 });
    const taken = suite.draft()?.version ?? 0;
    move(fresh, 400);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await fresh.written();
    expect(suite.draft()?.version).toBe(taken + 1);
    expect(suite.draft()?.layout.nodes.find((node) => node.id === 'L-1')).toMatchObject({ x: 400, y: 400 });
  });
});

describe('a write sent from a stale version', () => {
  it('is refused with CONFLICTED_VIEW_VERSION when it is a draft write, a save of a view or a restore, and stores nothing', async () => {
    suite = await startSuite();
    const { a, id } = await twoTabs(suite);
    move(a, 100);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await a.written();
    const stored = structuredClone(suite.draft());
    const body = { notes: null, layout: stored?.layout, queryContext: stored?.queryContext } as Parameters<Tab['client']['saveDraft']>[2];
    expect(await a.client.saveDraft(id, 1, body)).toMatchObject({ ok: false, failure: { code: 'CONFLICTED_VIEW_VERSION' } });
    expect(await a.client.saveView(id, 1, { name: 'Stale', notes: null })).toMatchObject({ ok: false, failure: { code: 'CONFLICTED_VIEW_VERSION' } });
    expect(suite.store.namedViews).toHaveLength(0);
    const saved = await a.client.saveView(id, stored?.version ?? 0, { name: 'Fresh', notes: null });
    expect(saved).toMatchObject({ ok: true });
    const viewId = saved.ok ? saved.value.view.id : '';
    expect(await a.client.restoreView(id, viewId, 1)).toMatchObject({ ok: false, failure: { code: 'CONFLICTED_VIEW_VERSION' } });
    expect(suite.draft()?.layout).toEqual(stored?.layout);
  });

  it('is refused for a rename or a delete of a view sent with a stale view version', async () => {
    suite = await startSuite();
    const { a, id } = await twoTabs(suite);
    const saved = await a.client.saveView(id, suite.draft()?.version ?? 0, { name: 'First', notes: 'kept' });
    const viewId = saved.ok ? saved.value.view.id : '';
    expect(await a.client.renameView(id, viewId, 1, 'Second')).toMatchObject({ ok: true });
    expect(await a.client.renameView(id, viewId, 1, 'Third')).toMatchObject({ ok: false, failure: { code: 'CONFLICTED_VIEW_VERSION' } });
    expect(await a.client.deleteView(id, viewId, 1, null)).toMatchObject({ ok: false, failure: { code: 'CONFLICTED_VIEW_VERSION' } });
    expect(suite.store.namedViews.map((view) => view.name)).toEqual(['Second']);
    expect(suite.store.namedViews[0]?.deletedAt).toBeUndefined();
  });

  it('is refused for a draft write that carries the version an earlier write has already raised', async () => {
    suite = await startSuite();
    const { a, id } = await twoTabs(suite);
    move(a, 100);
    await suite.advance(AUTOSAVE_DELAY_MS);
    await a.written();
    const first = structuredClone(suite.draft());
    const again = { notes: null, layout: { ...first?.layout, layout: 'grid' }, queryContext: first?.queryContext } as Parameters<Tab['client']['saveDraft']>[2];
    expect(await a.client.saveDraft(id, (first?.version ?? 1) - 1, again)).toMatchObject({ ok: false, failure: { code: 'CONFLICTED_VIEW_VERSION' } });
    expect(suite.draft()).toEqual(first);
  });
});
