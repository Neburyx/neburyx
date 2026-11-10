import type { InvestigationResponse, ReadRefsRequest, RestoreViewResponse } from '@neburyx/contracts';
import { mappingNoticesOf } from '../draft/mapping-notice.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, ApiResult } from '../api/client.js';
import { AUTOSAVE_DELAY_MS, draftSyncOf } from '../draft/draft-sync.js';
import { openById, openedKey } from '../investigations/open-flow.js';
import { INVESTIGATION_A, investigationOf, knowing, nodeOf } from '../investigations/test-data.js';
import { createClientState } from '../state/client-state.js';
import { result } from '../state/test-data.js';
import { elementKey } from '../state/keys.js';
import { failure } from './view-fixtures.js';
import { restoreNoticeOf } from './restore-notice.js';
import { restoreNamedView } from './restore-view.js';

const CONTEXT = { principalId: 'principal-1', mask: false };
const VIEW = '0192f000-0000-7000-8000-0000000000b1';
const SAVED_AT = '2026-10-30T09:42:00.000Z';
const investigation = investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1');
const NO_FILTERS = { entityTypes: [], relTypes: [], time: null, properties: [] };
const entry = (id: string, extra: Record<string, unknown> = {}) => ({ t: 'kind-a', id, pinned: false, hidden: false, groupId: null, ...extra });
const key2 = () => openedKey('source-a', 'principal-1', '0192f000-0000-7000-8000-0000000000a9', false);
const key = (id: string) => elementKey({ sourceId: 'source-a', entityType: 'kind-a', stableId: id });

/** What the server holds after the view is restored: three entities with a layout, positions, a pin, a hidden entity, a type filter and a viewport. */
function restoredDraft(version: number): RestoreViewResponse['draft'] {
  return {
    version,
    notes: 'restored note',
    basedOnViewId: VIEW,
    layout: { schemaVersion: 1, layout: 'radial', nodes: [entry('A-1'), entry('B', { x: 10, y: 20, pinned: true }), entry('C', { hidden: true })], edges: [], groups: [], viewport: { zoom: 2, x: 5, y: 6 } },
    queryContext: { schemaVersion: 1, loaded: { nodes: ['A-1', 'B', 'C'].map((id) => ({ t: 'kind-a', id })), edges: [] }, expansions: [], filters: NO_FILTERS },
  };
}

interface Options {
  readonly restore?: (version: number) => ApiResult<RestoreViewResponse>;
  readonly gone?: readonly string[];
  readonly readFails?: () => boolean;
  readonly saveDraft?: ApiClient['saveDraft'];
  readonly beforeRead?: () => Promise<void>;
  readonly mapping?: Partial<Pick<InvestigationResponse, 'unmapped' | 'mappingChange'>>;
}

function rig(options: Options = {}) {
  const writes: { version: number; notes: string | null }[] = [];
  const restores: number[] = [];
  const asked: ReadRefsRequest[] = [];
  let served: Pick<InvestigationResponse, 'draft' | 'save'> & Partial<Pick<InvestigationResponse, 'unmapped' | 'mappingChange'>>;
  const opening = { version: 3, notes: 'old note', basedOnViewId: null, layout: { schemaVersion: 1 as const, layout: 'force', nodes: [entry('A-1')], edges: [], groups: [] }, queryContext: { schemaVersion: 1 as const, loaded: { nodes: [{ t: 'kind-a', id: 'A-1' }], edges: [] }, expansions: [], filters: NO_FILTERS } } satisfies InvestigationResponse['draft'];
  served = { draft: opening, save: { state: 'unsaved', savedAt: null } };
  const { client } = knowing([], {
    getInvestigation: async () => ({ ok: true, value: { investigation, ...served } }),
    getEntity: async (ref) => ({ ok: true, value: nodeOf(ref.sourceId, ref.entityType, ref.stableId) }),
    readRefs: async (request, signal) => {
      asked.push(request);
      await options.beforeRead?.();
      if (signal?.aborted === true) return { ok: false, failure: { code: 'ABORTED' } };
      if (options.readFails?.() === true) return { ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: 't' } };
      const gone = options.gone ?? [];
      const found = request.entities.filter((ref) => !gone.includes(ref.stableId));
      return { ok: true, value: { nodes: found.map((ref) => nodeOf(ref.sourceId, ref.entityType, ref.stableId)), edges: [], missing: { entities: request.entities.filter((ref) => gone.includes(ref.stableId)), edges: [] } } };
    },
    saveDraft:
      options.saveDraft ??
      (async (_id, version, body) => {
        writes.push({ version, notes: body.notes });
        return { ok: true, value: { version: version + 1, save: { state: 'unsaved', savedAt: null }, notes: body.notes } };
      }),
    restoreView: async (_id, _viewId, version) => {
      restores.push(version);
      const result = (options.restore ?? ((current) => ({ ok: true, value: { draft: restoredDraft(current + 1), save: { state: 'saved', savedAt: SAVED_AT } } })))(version);
      if (result.ok) served = { draft: result.value.draft, save: result.value.save, ...(options.mapping ?? {}) };
      return result;
    },
  });
  return { client, writes, restores, asked };
}

async function opened(options: Options = {}) {
  const parts = rig(options);
  const state = createClientState();
  expect((await openById(parts.client, state, INVESTIGATION_A, CONTEXT)).kind).toBe('shown');
  return { ...parts, state };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('restoring a view into the draft', () => {
  it('shows what the view holds: its entities, layout, positions, pins, hidden items and viewport, read again by reference', async () => {
    const { client, state, asked } = await opened();
    expect(await restoreNamedView(client, state, VIEW)).toEqual({ kind: 'restored', someMissing: false });
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual(['A-1', 'B', 'C']);
    const presentation = state.presentation.view.getState();
    expect(presentation.layout).toBe('radial');
    expect(presentation.positions.get(key('B'))).toEqual({ x: 10, y: 20 });
    expect(presentation.pins.has(key('B'))).toBe(true);
    expect(presentation.hidden.has(key('C'))).toBe(true);
    expect(presentation.viewport).toEqual({ zoom: 2, x: 5, y: 6 });
    expect(asked.at(-1)?.entities.map((ref) => ref.stableId)).toEqual(['A-1', 'B', 'C']);
  });

  it('shows "Saved" with the view time, holds the new version, notes and view, and autosave goes on from that version', async () => {
    const { client, state, writes } = await opened();
    await restoreNamedView(client, state, VIEW);
    expect(state.investigation.getState().record?.save).toEqual({ kind: 'saved', at: SAVED_AT });
    expect(draftSyncOf(state, client).stateOf(INVESTIGATION_A)).toEqual({ version: 4, notes: 'restored note', basedOnViewId: VIEW });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(writes).toEqual([]);
    state.presentation.setPosition(key('A-1'), { x: 1, y: 2 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes).toEqual([{ version: 4, notes: 'restored note' }]);
  });

  it('reads "Unsaved" after the next content change once the restored draft is being written again', async () => {
    const { client, state } = await opened();
    await restoreNamedView(client, state, VIEW);
    expect(state.investigation.getState().record?.save).toEqual({ kind: 'saved', at: SAVED_AT });
    state.presentation.setPosition(key('A-1'), { x: 3, y: 3 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(state.investigation.getState().record?.save).toEqual({ kind: 'unsaved' });
  });

  it('leaves the title and the version of the investigation as they were: a view holds no title', async () => {
    const { client, state } = await opened();
    const before = state.investigation.getState().record;
    await restoreNamedView(client, state, VIEW);
    expect(state.investigation.getState().record).toMatchObject({ title: before?.title, version: before?.version, caseRef: before?.caseRef });
  });

  it('asks for the view to be fitted when the restored draft holds no viewport, and shows the viewport it holds otherwise', async () => {
    const { client, state } = await opened();
    state.presentation.setViewport({ zoom: 3, x: 40, y: 40 });
    await restoreNamedView(client, state, VIEW);
    expect(state.presentation.view.getState().viewport).toEqual({ zoom: 2, x: 5, y: 6 });
    const bare = await opened({ restore: (version) => ({ ok: true, value: { draft: { ...restoredDraft(version + 1), layout: { ...restoredDraft(version + 1).layout, viewport: undefined } }, save: { state: 'saved', savedAt: SAVED_AT } } }) });
    await restoreNamedView(bare.client, bare.state, VIEW);
    expect(bare.state.presentation.view.getState().viewChange).toEqual({ show: 'fit' });
  });

  it('shows no mapping banner for a view under the current mapping, and reads "Saved" with the view time', async () => {
    const { client, state } = await opened();
    await restoreNamedView(client, state, VIEW);
    expect(mappingNoticesOf(state).notice.getState()).toBeUndefined();
    expect(state.investigation.getState().record?.save).toEqual({ kind: 'saved', at: SAVED_AT });
  });

  it('shows the mapping banner with the dropped filters, and writes nothing until it has been shown, when the view was saved under an older mapping', async () => {
    const { client, state, writes } = await opened({ mapping: { mappingChange: { droppedFilters: [{ name: 'ghost', reason: 'property-removed' }] }, unmapped: { nodes: [], edges: [] } } });
    await restoreNamedView(client, state, VIEW);
    expect(mappingNoticesOf(state).notice.getState()).toMatchObject({ investigationId: INVESTIGATION_A, droppedFilters: [{ name: 'ghost', reason: 'property-removed' }], canChange: true });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(writes).toEqual([]);
  });

  it('draws the items of an unmapped type as placeholders, reading nothing for them, when the view names them', async () => {
    const unmapped = { nodes: [{ t: 'gone', id: 'X' }], edges: [] };
    const { client, state, asked } = await opened({ mapping: { unmapped } });
    await restoreNamedView(client, state, VIEW);
    expect(asked.at(-1)?.entities.some((ref) => ref.entityType === 'gone')).toBe(false);
  });

  it('drops a pending autosave that was not sent, and sends the restore with the draft version the server holds', async () => {
    const { client, state, writes, restores } = await opened();
    state.presentation.setPosition(key('A-1'), { x: 9, y: 9 });
    expect(await restoreNamedView(client, state, VIEW)).toEqual({ kind: 'restored', someMissing: false });
    expect(restores).toEqual([3]);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(writes).toEqual([]);
  });

  it('waits for an autosave already in flight and sends the restore with the version that write answered', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const written: number[] = [];
    const { client, state, restores } = await opened({
      saveDraft: async (_id, version, body) => {
        written.push(version);
        await gate;
        return { ok: true, value: { version: version + 1, save: { state: 'unsaved', savedAt: null }, notes: body.notes } };
      },
    });
    state.presentation.setPosition(key('A-1'), { x: 9, y: 9 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(written).toEqual([3]);
    const restoring = restoreNamedView(client, state, VIEW);
    await vi.advanceTimersByTimeAsync(0);
    expect(restores).toEqual([]);
    release();
    expect(await restoring).toEqual({ kind: 'restored', someMissing: false });
    expect(restores).toEqual([4]);
  });

  it('leaves the draft and the canvas as they were and says failed when the restore is refused, and the changes on the canvas are written by the next autosave', async () => {
    const { client, state, writes } = await opened({ restore: () => failure('INTERNAL_ERROR') });
    state.presentation.setPosition(key('A-1'), { x: 9, y: 9 });
    expect(await restoreNamedView(client, state, VIEW)).toEqual({ kind: 'failed' });
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual(['A-1']);
    expect(state.presentation.view.getState().positions.get(key('A-1'))).toEqual({ x: 9, y: 9 });
    expect(draftSyncOf(state, client).stateOf(INVESTIGATION_A)).toEqual({ version: 3, notes: 'old note', basedOnViewId: null });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes).toEqual([{ version: 3, notes: 'old note' }]);
  });

  it('puts the draft in its conflict state and says changed-elsewhere when the draft version is stale', async () => {
    const { client, state } = await opened({ restore: () => failure('CONFLICTED_VIEW_VERSION') });
    expect(await restoreNamedView(client, state, VIEW)).toEqual({ kind: 'changed-elsewhere' });
    expect(draftSyncOf(state, client).status.getState()).toEqual({ kind: 'conflict' });
    expect(state.loadedGraph().nodes).toHaveLength(1);
  });

  it('says changed-elsewhere without sending a restore when the draft was already found changed elsewhere', async () => {
    const { client, state, restores } = await opened({ restore: () => failure('CONFLICTED_VIEW_VERSION') });
    await restoreNamedView(client, state, VIEW);
    expect(await restoreNamedView(client, state, VIEW)).toEqual({ kind: 'changed-elsewhere' });
    expect(restores).toHaveLength(1);
  });

  it('shows the rest and notes that some items are not available when some of the view’s items cannot be read again', async () => {
    const { client, state } = await opened({ gone: ['B'] });
    expect(await restoreNamedView(client, state, VIEW)).toEqual({ kind: 'restored', someMissing: true });
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual(['A-1', 'C']);
    expect(restoreNoticeOf(state).missing.getState()).toBe(true);
  });

  it('shows the read failure with a retry, keeps the old canvas, writes nothing while the read has not succeeded, and shows the view once the retry reads it', async () => {
    let failing = true;
    const { client, state, writes } = await opened({ readFails: () => failing });
    const outcome = await restoreNamedView(client, state, VIEW);
    if (outcome.kind !== 'read-failed') throw new Error(`expected read-failed, got ${outcome.kind}`);
    expect(outcome.failure.code).toBe('QUERY_TIMEOUT');
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual(['A-1']);
    expect(state.investigation.getState().record?.save).toEqual({ kind: 'unsaved' });
    state.presentation.setPosition(key('A-1'), { x: 5, y: 5 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(writes).toEqual([]);
    expect(draftSyncOf(state, client).stateOf(INVESTIGATION_A)).toEqual({ version: 4, notes: 'restored note', basedOnViewId: VIEW });
    failing = false;
    expect(await outcome.retry()).toEqual({ kind: 'restored', someMissing: false });
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual(['A-1', 'B', 'C']);
    expect(state.investigation.getState().record?.save).toEqual({ kind: 'saved', at: SAVED_AT });
  });

  it('says left, and reads the restored investigation anew when it is opened again, when another investigation is shown before the graph is read', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { client, state, asked } = await opened({ beforeRead: () => gate });
    const restoring = restoreNamedView(client, state, VIEW);
    await vi.advanceTimersByTimeAsync(0);
    const other = result('source-a', ['Z']);
    state.show({ id: '0192f000-0000-7000-8000-0000000000a9', sourceId: 'source-a', record: { title: 'Other', caseRef: null, status: 'open', readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [key2()], nodeRefs: other.nodes.map((node) => node.ref), edgeRefs: [] }, [{ key: key2(), result: other }]);
    release();
    expect(await restoring).toEqual({ kind: 'left' });
    expect(state.holds(INVESTIGATION_A, false)).toBe(false);
    expect(await openById(client, state, INVESTIGATION_A, CONTEXT)).toMatchObject({ kind: 'shown', activation: 'fresh' });
    expect(asked.length).toBeGreaterThan(0);
    expect(draftSyncOf(state, client).stateOf(INVESTIGATION_A)?.version).toBe(4);
  });

  it('sends the restore even when the read is ended, and then forgets the investigation so that it is read anew when it is opened again and autosave goes on', async () => {
    const controller = new AbortController();
    const { client, state, restores, writes } = await opened();
    controller.abort();
    expect(await restoreNamedView(client, state, VIEW, controller.signal)).toEqual({ kind: 'left' });
    expect(restores).toEqual([3]);
    expect(state.holds(INVESTIGATION_A, false)).toBe(false);
    expect(await openById(client, state, INVESTIGATION_A, CONTEXT)).toMatchObject({ kind: 'shown', activation: 'fresh' });
    state.presentation.setPosition(key('A-1'), { x: 4, y: 4 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes).toHaveLength(1);
  });

  it('answers failed when no investigation is shown', async () => {
    const { client } = rig();
    expect(await restoreNamedView(client, createClientState(), VIEW)).toEqual({ kind: 'failed' });
  });
});
