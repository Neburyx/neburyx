import { afterEach, describe, expect, it } from 'vitest';
import { mappingNoticesOf } from '../../../apps/web/src/draft/mapping-notice.js';
import { UNMAPPED_FLAG } from '../../../apps/web/src/draft/unmapped.js';
import { restoreNamedView } from '../../../apps/web/src/views/restore-view.js';
import { saveNamedView } from '../../../apps/web/src/views/save-view.js';
import { AUTOSAVE_DELAY_MS, idsRead, mappingOf, ref, startSuite, type Suite, type Tab } from './rig.js';
import { HAS, LINKED } from './scenarios.js';

let suite: Suite | undefined;
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});

const writes = (tab: Tab) => tab.draftWrites();
const WEIGHT = { key: 'weight', op: 'gte' as const, values: ['3'] };

/** A draft and a named view saved under the full mapping: a part and a leaf, both relationships, the part type switched off, and a property filter. */
async function saved(running: Suite): Promise<{ readonly id: string; readonly viewId: string }> {
  const tab = running.tab();
  await tab.open(ref('hub', 'H-1'));
  const id = tab.state.investigation.getState().id ?? '';
  tab.mapTypes(['hub', 'leaf', 'part'], ['LINKED', 'HAS']);
  await tab.load([ref('leaf', 'L-1'), ref('part', 'P-1')], [LINKED('r-L1'), HAS('r-P1')]);
  tab.state.presentation.setPositions(new Map([[tab.nodeKey('part', 'P-1'), { x: 300, y: 40 }], [tab.nodeKey('leaf', 'L-1'), { x: -20, y: 10 }]]));
  tab.state.setEntityTypeOff('part', true);
  await running.advance(AUTOSAVE_DELAY_MS);
  await tab.written();
  const stored = running.draft();
  if (stored === undefined) throw new Error('the draft was stored');
  const withFilter = await tab.client.saveDraft(id, stored.version, { notes: null, layout: stored.layout, queryContext: { ...stored.queryContext, filters: { ...stored.queryContext.filters, properties: [WEIGHT] } } });
  expect(withFilter).toMatchObject({ ok: true });
  const view = await tab.client.saveView(id, withFilter.ok ? withFilter.value.version : 0, { name: 'Under the full mapping', notes: null });
  expect(view).toMatchObject({ ok: true });
  tab.dispose();
  return { id, viewId: view.ok ? view.value.view.id : '' };
}

const placeholders = (tab: Tab) => tab.state.loadedGraph().nodes.filter((node) => node.qualityFlags.includes(UNMAPPED_FLAG)).map((node) => node.ref.stableId).sort();
const MAPPING_WITHOUT_PART = (weight: 'removed' | 'personal') => mappingOf({ without: ['part'], weight });

describe.each([
  ['removed', 'property-removed'],
  ['personal', 'now-personal'],
] as const)('an investigation reopened after a type and a property (%s) left the mapping', (weight, reason) => {
  it('shows a placeholder at the saved place for each unmapped item, names the dropped property filter, raises no error and reads nothing for a placeholder', async () => {
    suite = await startSuite();
    const { id } = await saved(suite);
    await suite.restart(MAPPING_WITHOUT_PART(weight));
    const tab = suite.tab();
    const opened = await tab.openById(id);
    expect(opened).toMatchObject({ kind: 'shown', id });
    expect(placeholders(tab)).toEqual(['P-1']);
    expect(tab.state.presentation.view.getState().positions.get(tab.nodeKey('part', 'P-1'))).toEqual({ x: 300, y: 40 });
    const notice = mappingNoticesOf(tab.state).notice.getState();
    expect(notice).toMatchObject({ investigationId: id, hasUnmapped: true, canChange: true });
    expect(notice?.droppedFilters).toEqual([{ name: 'weight', reason }]);
    const asked = idsRead(suite.executor.calls);
    expect(asked).not.toContain('P-1');
    expect(asked).toContain('L-1');
  });

  it('stores the draft under the current mapping only after the notice has been shown, and keeps the type off', async () => {
    suite = await startSuite();
    const { id } = await saved(suite);
    const next = MAPPING_WITHOUT_PART(weight);
    const hashBefore = suite.draft()?.mappingHash;
    await suite.restart(next);
    const tab = suite.tab();
    await tab.openById(id);
    await suite.advance(AUTOSAVE_DELAY_MS * 2);
    expect(writes(tab)).toEqual([]);
    expect(suite.draft()?.mappingHash).toBe(hashBefore);
    mappingNoticesOf(tab.state).notice.getState()?.onShown?.();
    await suite.advance(AUTOSAVE_DELAY_MS);
    await suite.until(() => writes(tab).length === 1, 'the write under the current mapping');
    await tab.written();
    expect(suite.draft()?.mappingHash).toBe(next.sources[0]?.configHash);
    expect(suite.draft()?.mappingHash).not.toBe(hashBefore);
    expect(suite.draft()?.queryContext.filters.entityTypes).toEqual(['hub', 'leaf']);
  });

  it('shows the same placeholders and notice for a view saved under the old mapping and restored under the new one', async () => {
    suite = await startSuite();
    const { id, viewId } = await saved(suite);
    await suite.restart(MAPPING_WITHOUT_PART(weight));
    const tab = suite.tab();
    await tab.openById(id);
    expect(await restoreNamedView(tab.client, tab.state, viewId)).toMatchObject({ kind: 'restored' });
    expect(placeholders(tab)).toEqual(['P-1']);
    expect(mappingNoticesOf(tab.state).notice.getState()?.droppedFilters).toEqual([{ name: 'weight', reason }]);
  });
});

describe('a type that is mapped again', () => {
  it('comes back as items, and the saved type filter is on as it was', async () => {
    suite = await startSuite();
    const { id } = await saved(suite);
    await suite.restart(MAPPING_WITHOUT_PART('removed'));
    const during = suite.tab();
    await during.openById(id);
    mappingNoticesOf(during.state).notice.getState()?.onShown?.();
    await suite.advance(AUTOSAVE_DELAY_MS);
    await during.written();
    during.dispose();

    await suite.restart(mappingOf());
    const again = suite.tab();
    expect(await again.openById(id)).toMatchObject({ kind: 'shown', id });
    again.mapTypes(['hub', 'leaf', 'part'], ['LINKED', 'HAS']);
    expect(placeholders(again)).toEqual([]);
    expect(again.state.loadedGraph().nodes.map((node) => node.ref.stableId).sort()).toEqual(['H-1', 'L-1', 'P-1']);
    expect([...again.state.presentation.view.getState().typeFilter.offEntityTypes]).toEqual(['part']);
  });

  it('is saved with a view in the same way: a view saved while the type was unmapped keeps the type off for when it is mapped again', async () => {
    suite = await startSuite();
    const { id } = await saved(suite);
    await suite.restart(MAPPING_WITHOUT_PART('removed'));
    const during = suite.tab();
    await during.openById(id);
    mappingNoticesOf(during.state).notice.getState()?.onShown?.();
    await suite.advance(AUTOSAVE_DELAY_MS);
    await during.written();
    expect(await saveNamedView(during.client, during.state, { name: 'While unmapped', notes: null })).toEqual({ kind: 'saved' });
    expect(suite.store.namedViews.at(-1)?.queryContext.filters.entityTypes).toEqual(['hub', 'leaf']);
  });
});
