import { describe, expect, it } from 'vitest';
import { key, result } from '../state/test-data.js';
import { failure, namedView, rig, viewsServer } from './view-fixtures.js';
import { createViewList, type ViewListState } from './view-list.js';

const ready = (state: ViewListState) => {
  if (state.kind !== 'ready') throw new Error(`the list is ${state.kind}`);
  return state;
};

function listOf(server: ReturnType<typeof viewsServer>, overrides: Parameters<typeof rig>[0] = {}) {
  const parts = rig({ listViews: server.listViews, renameView: server.renameView, ...overrides });
  return { ...parts, list: createViewList(parts.client, parts.state) };
}

describe('the list of named views', () => {
  it('reads the first page with the exact count and the draft time, and starts idle', async () => {
    const server = viewsServer([namedView(3), namedView(2), namedView(1)]);
    const { list } = listOf(server);
    expect(list.state.getState()).toEqual({ kind: 'idle' });
    await list.load();
    const state = ready(list.state.getState());
    expect(state.items.map((item) => item.name)).toEqual(['View 3', 'View 2', 'View 1']);
    expect(state).toMatchObject({ count: 3, nextCursor: null, draft: { updatedAt: '2026-11-10T09:42:00.000Z' } });
  });

  it('shows the failure of a read, and reads again on the next load, with the workspace untouched', async () => {
    let answers = 0;
    const server = viewsServer([namedView(1)]);
    const { list, state } = listOf(server, { listViews: async (...args) => (answers++ === 0 ? failure('INTERNAL_ERROR') : server.listViews(...args)) });
    await list.load();
    expect(list.state.getState().kind).toBe('failed');
    expect(state.investigation.getState().record?.title).toBe('Suspicious linked accounts');
    await list.load();
    expect(ready(list.state.getState()).items).toHaveLength(1);
  });

  it('loads the next page until nextCursor is null, lists each view once, and keeps the count of the first page', async () => {
    const server = viewsServer(Array.from({ length: 7 }, (_, n) => namedView(7 - n)), 3);
    const { list } = listOf(server);
    await list.load();
    while (ready(list.state.getState()).nextCursor !== null) await list.more();
    const state = ready(list.state.getState());
    expect(state.items.map((item) => item.name)).toEqual(['View 7', 'View 6', 'View 5', 'View 4', 'View 3', 'View 2', 'View 1']);
    expect(state.count).toBe(7);
    expect(server.listed.map((call) => call.cursor)).toEqual([undefined, 'c3', 'c6']);
  });

  it('keeps the rows shown when the next page cannot be read, and says so', async () => {
    const server = viewsServer(Array.from({ length: 4 }, (_, n) => namedView(4 - n)), 2);
    const { list } = listOf(server, { listViews: async (id, page, signal) => (page.cursor === undefined ? server.listViews(id, page, signal) : failure('INTERNAL_ERROR')) });
    await list.load();
    await list.more();
    expect(ready(list.state.getState())).toMatchObject({ moreFailed: true, loadingMore: false });
    expect(ready(list.state.getState()).items).toHaveLength(2);
  });

  it('does not read a page twice at once', async () => {
    const server = viewsServer(Array.from({ length: 4 }, (_, n) => namedView(4 - n)), 2);
    const { list } = listOf(server);
    await list.load();
    await Promise.all([list.more(), list.more()]);
    expect(server.listed).toHaveLength(2);
  });

  it('drops a read that was overtaken by a newer one, so a stale answer never overwrites a newer', async () => {
    const server = viewsServer([namedView(1)]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const { list } = listOf(server, {
      listViews: async (...args) => {
        if (first) {
          first = false;
          await gate;
          return { ok: true, value: { items: [namedView(9)], nextCursor: null, count: { value: 1, quality: 'exact', scope: 'named-views' }, draft: { basedOnViewId: null, updatedAt: '2026-11-10T09:00:00.000Z' } } };
        }
        return server.listViews(...args);
      },
    });
    const slow = list.load();
    await list.load();
    release();
    await slow;
    expect(ready(list.state.getState()).items.map((item) => item.name)).toEqual(['View 1']);
  });

  it('renames a view in the list with the name and version the server answered', async () => {
    const server = viewsServer([namedView(2), namedView(1)]);
    const { list } = listOf(server);
    await list.load();
    expect(await list.rename(namedView(1).id, 'Renamed')).toBe('renamed');
    expect(server.renamed).toEqual([{ viewId: namedView(1).id, version: 1, name: 'Renamed' }]);
    expect(ready(list.state.getState()).items.map((item) => `${item.name}:${item.version}`)).toEqual(['View 2:1', 'Renamed:2']);
  });

  it('answers failed and leaves the list as it was when a rename fails', async () => {
    const server = viewsServer([namedView(1)]);
    const { list } = listOf(server, { renameView: async () => failure('INTERNAL_ERROR') });
    await list.load();
    expect(await list.rename(namedView(1).id, 'Renamed')).toBe('failed');
    expect(ready(list.state.getState()).items[0]?.name).toBe('View 1');
  });

  it('answers conflict and reads the list again when the view was renamed elsewhere', async () => {
    const server = viewsServer([namedView(1)]);
    const { list } = listOf(server);
    await list.load();
    server.views[0] = { ...namedView(1), name: 'Elsewhere', version: 2 };
    expect(await list.rename(namedView(1).id, 'Mine')).toBe('conflict');
    expect(server.listed).toHaveLength(2);
    expect(ready(list.state.getState()).items[0]).toMatchObject({ name: 'Elsewhere', version: 2 });
  });

  it('does not show the list of another investigation while it reads', async () => {
    const server = viewsServer([namedView(1)]);
    const { list, state } = listOf(server);
    await list.load();
    const other = result('demo', ['B']);
    state.show({ id: '0192f000-0000-7000-8000-0000000000a2', sourceId: 'demo', record: { title: 'Other', caseRef: null, status: 'open', readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [key('demo')], nodeRefs: other.nodes.map((node) => node.ref), edgeRefs: [] }, [{ key: key('demo'), result: other }]);
    const reading = list.load();
    expect(list.state.getState().kind).toBe('loading');
    await reading;
  });
});
