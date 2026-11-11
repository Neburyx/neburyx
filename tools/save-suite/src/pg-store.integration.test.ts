import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { contentHashOf } from '../../../services/api/src/investigations/draft.js';
import { startPostgres, type TestPostgres } from '../../../services/api/src/testing/postgres.js';
import { AUTOSAVE_DELAY_MS, closePgStores, ref, startPgSuite, type PgSuite, type Tab } from './rig.js';
import { arranged, reopen } from './scenarios.js';

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
const move = (tab: Tab, x: number) => tab.state.presentation.setPositions(new Map([[tab.nodeKey('leaf', 'L-1'), { x, y: x }]]));
const body = (draft: NonNullable<Awaited<ReturnType<PgSuite['draft']>>>) => ({ notes: draft.notes, layout: draft.layout, queryContext: draft.queryContext }) as unknown as Parameters<Tab['client']['saveDraft']>[2];

describe('an investigation saved on real Postgres', () => {
  it('comes back exactly in a fresh client, writes nothing on the way back, and its stored content hash is the hash of the stored documents', async () => {
    suite = await startPgSuite(postgres);
    const { tab, id } = await arranged(suite);
    const reopened = await reopen(suite, id);
    expect(reopened.canonical()).toBe(tab.canonical());
    const stored = await suite.draft();
    const [row] = await suite.sql(`SELECT content_hash FROM saved_views WHERE kind = 'draft'`);
    expect(row?.['content_hash']).toBe(contentHashOf({ layout: stored?.layout, queryContext: stored?.queryContext } as never, stored?.notes ?? null));
    reopened.sync.flush();
    await suite.advance(AUTOSAVE_DELAY_MS);
    expect(writes(reopened)).toEqual([]);
    expect((await suite.draft())?.version).toBe(stored?.version);
  });

  it('shows a change written by the page-hidden flush in a fresh client', async () => {
    suite = await startPgSuite(postgres);
    const { tab, id } = await arranged(suite);
    const stored = writes(tab).length;
    move(tab, 777);
    suite.page.fire('pagehide');
    await suite.until(() => writes(tab).length === stored + 1, 'the keepalive write');
    expect(tab.keepalives).toEqual([writes(tab).at(-1)]);
    await tab.written();
    const fresh = await reopen(suite, id);
    expect(fresh.state.presentation.view.getState().positions.get(fresh.nodeKey('leaf', 'L-1'))).toEqual({ x: 777, y: 777 });
  });
});

describe.each([['first', false], ['second', true]] as const)('two draft writes of the same version, the %s sent first', (_name, reversed) => {
  it('stores exactly one and refuses the other with CONFLICTED_VIEW_VERSION', async () => {
    suite = await startPgSuite(postgres);
    const { tab, id } = await arranged(suite);
    const draft = await suite.draft();
    if (draft === undefined) throw new Error('the draft was stored');
    const one = { ...body(draft), layout: { ...draft.layout, layout: 'grid' } };
    const two = { ...body(draft), layout: { ...draft.layout, layout: 'hierarchical' } };
    const sent = reversed ? [two, one] : [one, two];
    const answers = await Promise.all(sent.map((each) => tab.client.saveDraft(id, draft.version, each as Parameters<Tab['client']['saveDraft']>[2])));
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(answers.filter((answer) => !answer.ok && answer.failure.code === 'CONFLICTED_VIEW_VERSION')).toHaveLength(1);
    expect((await suite.draft())?.version).toBe(draft.version + 1);
  });

  it('restores exactly one of two simultaneous restores of a view', async () => {
    suite = await startPgSuite(postgres);
    const { tab, id } = await arranged(suite);
    const draft = await suite.draft();
    const saved = await tab.client.saveView(id, draft?.version ?? 0, { name: 'A view', notes: null });
    const viewId = saved.ok ? saved.value.view.id : '';
    const version = saved.ok ? saved.value.draft.version : 0;
    const asks = [tab.client.restoreView(id, viewId, version), tab.client.restoreView(id, viewId, version)];
    const answers = await Promise.all(reversed ? asks.reverse() : asks);
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(answers.filter((answer) => !answer.ok && answer.failure.code === 'CONFLICTED_VIEW_VERSION')).toHaveLength(1);
  });
});

describe('a close made while a draft write is in flight', () => {
  it.each([false, true])('closes, and stores the write before the close or refuses it as read-only, never a write after it (close sent first: %s)', async (closeFirst) => {
    suite = await startPgSuite(postgres);
    const tab = suite.tab();
    for (let round = 0; round < 8; round += 1) {
      const opened = await tab.client.openInvestigation({ sourceId: 'demo', entity: ref('hub', 'H-1'), caseRef: `CASE-${round}`, mask: false });
      if (!opened.ok) throw new Error('the investigation was opened');
      const { id } = opened.value.investigation;
      const documents = { notes: null, layout: { schemaVersion: 1, layout: `layout-${round}`, nodes: [{ t: 'hub', id: 'H-1', pinned: false, hidden: false, groupId: null }], edges: [], groups: [] }, queryContext: { schemaVersion: 1, loaded: { nodes: [{ t: 'hub', id: 'H-1' }], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } } } as Parameters<Tab['client']['saveDraft']>[2];
      const write = () => tab.client.saveDraft(id, opened.value.draft.version, documents);
      const close = () => tab.client.changeInvestigationStatus(id, 'closed', opened.value.investigation.version);
      const [written, closed] = closeFirst ? await Promise.all([close(), write()]).then(([c, w]) => [w, c] as const) : await Promise.all([write(), close()]);
      expect(closed).toMatchObject({ ok: true });
      const [row] = await suite.sql(`SELECT i.status, v.version FROM investigations i JOIN saved_views v ON v.investigation_id = i.id AND v.kind = 'draft' WHERE i.id = $1`, [id]);
      expect(row?.['status']).toBe('closed');
      if (written.ok) {
        expect(row?.['version']).toBe(opened.value.draft.version + 1);
        const late = await tab.client.saveDraft(id, opened.value.draft.version + 1, documents);
        expect(late).toMatchObject({ ok: false, failure: { code: 'CONFLICT', details: { reason: 'investigation-read-only' } } });
      } else {
        expect(written).toMatchObject({ ok: false, failure: { code: 'CONFLICT', details: { reason: 'investigation-read-only' } } });
        expect(row?.['version']).toBe(opened.value.draft.version);
      }
    }
  });
});
