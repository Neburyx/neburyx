import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mappingNoticesOf } from '../../../apps/web/src/draft/mapping-notice.js';
import { UNMAPPED_FLAG } from '../../../apps/web/src/draft/unmapped.js';
import { restoreNamedView } from '../../../apps/web/src/views/restore-view.js';
import { startPostgres, type TestPostgres } from '../../../services/api/src/testing/postgres.js';
import { AUTOSAVE_DELAY_MS, closePgStores, mappingOf, ref, startPgSuite, type PgSuite, type Tab } from './rig.js';
import { HAS, LINKED, reopen } from './scenarios.js';

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

const writes = (tab: Tab) => tab.draftWrites();
const hashOf = (mapping: ReturnType<typeof mappingOf>) => mapping.sources[0]?.configHash;
const NEXT = () => mappingOf({ without: ['part'], weight: 'removed' });
const WEIGHT = { key: 'weight', op: 'gte' as const, values: ['3'] };

/** A draft and a named view saved under the full mapping, with a part, a leaf and a property filter. */
async function saved(running: PgSuite): Promise<{ readonly id: string; readonly viewId: string }> {
  const tab = running.tab();
  await tab.open(ref('hub', 'H-1'));
  const id = tab.state.investigation.getState().id ?? '';
  tab.mapTypes(['hub', 'leaf', 'part'], ['LINKED', 'HAS']);
  await tab.load([ref('leaf', 'L-1'), ref('part', 'P-1')], [LINKED('r-L1'), HAS('r-P1')]);
  tab.state.presentation.setPositions(new Map([[tab.nodeKey('part', 'P-1'), { x: 300, y: 40 }]]));
  await running.advance(AUTOSAVE_DELAY_MS);
  await tab.written();
  const stored = await running.draft();
  if (stored === undefined) throw new Error('the draft was stored');
  const withFilter = await tab.client.saveDraft(id, stored.version, { notes: null, layout: stored.layout, queryContext: { ...stored.queryContext, filters: { ...stored.queryContext.filters, properties: [WEIGHT] } } } as Parameters<Tab['client']['saveDraft']>[2]);
  expect(withFilter).toMatchObject({ ok: true });
  const view = await tab.client.saveView(id, withFilter.ok ? withFilter.value.version : 0, { name: 'Under the full mapping', notes: null });
  expect(view).toMatchObject({ ok: true });
  tab.dispose();
  return { id, viewId: view.ok ? view.value.view.id : '' };
}

describe('an investigation reopened under another mapping, on real Postgres', () => {
  it('shows the placeholders and the dropped-filter notice with no error, and the next write stores the new mapping hash', async () => {
    suite = await startPgSuite(postgres);
    const { id } = await saved(suite);
    const before = (await suite.draft())?.mappingHash;
    expect(before).toBe(hashOf(mappingOf()));
    await suite.restart(NEXT());
    const tab = suite.tab();
    expect(await tab.openById(id)).toMatchObject({ kind: 'shown', id });
    expect(tab.state.loadedGraph().nodes.filter((node) => node.qualityFlags.includes(UNMAPPED_FLAG)).map((node) => node.ref.stableId)).toEqual(['P-1']);
    expect(mappingNoticesOf(tab.state).notice.getState()?.droppedFilters).toEqual([{ name: 'weight', reason: 'property-removed' }]);
    await suite.advance(AUTOSAVE_DELAY_MS * 2);
    expect(writes(tab)).toEqual([]);
    expect((await suite.draft())?.mappingHash).toBe(before);
    mappingNoticesOf(tab.state).notice.getState()?.onShown?.();
    await suite.advance(AUTOSAVE_DELAY_MS);
    await suite.until(() => writes(tab).length === 1, 'the write under the new mapping');
    await tab.written();
    expect((await suite.draft())?.mappingHash).toBe(hashOf(NEXT()));
  });

  it('shows the notice for a view saved under the old mapping and restored under the new one, and stores the new hash with the restored draft', async () => {
    suite = await startPgSuite(postgres);
    const { id, viewId } = await saved(suite);
    await suite.restart(NEXT());
    const tab = suite.tab();
    await tab.openById(id);
    expect(await restoreNamedView(tab.client, tab.state, viewId)).toMatchObject({ kind: 'restored' });
    expect(mappingNoticesOf(tab.state).notice.getState()?.droppedFilters).toEqual([{ name: 'weight', reason: 'property-removed' }]);
    mappingNoticesOf(tab.state).notice.getState()?.onShown?.();
    await suite.advance(AUTOSAVE_DELAY_MS);
    await tab.written();
    expect((await suite.draft())?.mappingHash).toBe(hashOf(NEXT()));
  });

  it('writes no new hash and no draft when the mapping did not change', async () => {
    suite = await startPgSuite(postgres);
    const { id } = await saved(suite);
    const before = await suite.draft();
    await suite.restart(mappingOf());
    const tab = await reopen(suite, id);
    expect(mappingNoticesOf(tab.state).notice.getState()).toBeUndefined();
    tab.sync.flush();
    await suite.advance(AUTOSAVE_DELAY_MS * 2);
    expect(writes(tab)).toEqual([]);
    expect((await suite.draft())?.mappingHash).toBe(before?.mappingHash);
    expect((await suite.draft())?.version).toBe(before?.version);
  });
});
