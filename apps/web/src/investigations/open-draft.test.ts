import { MAX_READ_REFS, type InvestigationResponse, type ReadRefsRequest } from '@neburyx/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { AUTOSAVE_DELAY_MS, draftSyncOf } from '../draft/draft-sync.js';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { openById, openEntity } from './open-flow.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf, openedOf } from './test-data.js';

const CONTEXT = { principalId: 'principal-1', mask: false };
const investigation = investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1');
const entry = (id: string, extra: Record<string, unknown> = {}) => ({ t: 'kind-a', id, pinned: false, hidden: false, groupId: null, ...extra });
const NO_FILTERS = { entityTypes: [], relTypes: [], time: null, properties: [] };

function draftOf(ids: readonly string[], layoutExtra: Record<string, unknown> = {}, nodeExtras: Record<string, Record<string, unknown>> = {}, edges: InvestigationResponse['draft']['queryContext']['loaded']['edges'] = []): InvestigationResponse['draft'] {
  return {
    version: 4,
    notes: 'a note',
    basedOnViewId: null,
    layout: { schemaVersion: 1, layout: 'force', nodes: ids.map((id) => entry(id, nodeExtras[id])), edges: edges.map((edge) => ({ ...edge, hidden: false })), groups: [], ...layoutExtra },
    queryContext: { schemaVersion: 1, loaded: { nodes: ids.map((id) => ({ t: 'kind-a', id })), edges: [...edges] }, expansions: [], filters: NO_FILTERS },
  };
}

interface Rig {
  readonly asked: ReadRefsRequest[];
  readonly writes: { readonly version: number; readonly body: Parameters<ReturnType<typeof knowing>['client']['saveDraft']>[2] }[];
  readonly client: ReturnType<typeof knowing>['client'];
}

function rig(draft: InvestigationResponse['draft'], gone: readonly string[] = [], fails = false, onOpen?: () => void): Rig {
  const asked: ReadRefsRequest[] = [];
  const writes: Rig['writes'] = [];
  const { client } = knowing([], {
    getInvestigation: async () => ({ ok: true, value: { investigation, draft, save: { state: 'unsaved', savedAt: null } } }),
    readRefs: async (request): Promise<ApiResult<{ nodes: ReturnType<typeof nodeOf>[]; edges: never[]; missing: { entities: never[]; edges: never[] } }>> => {
      asked.push(request);
      onOpen?.();
      if (fails) return { ok: false, failure: { code: 'QUERY_TIMEOUT', message: 'x', retryable: true, traceId: 't' } };
      const found = request.entities.filter((ref) => !gone.includes(ref.stableId));
      return { ok: true, value: { nodes: found.map((ref) => nodeOf(ref.sourceId, ref.entityType, ref.stableId)), edges: [], missing: { entities: request.entities.filter((ref) => gone.includes(ref.stableId)) as never[], edges: [] } } };
    },
    saveDraft: async (_id, version, body) => {
      writes.push({ version, body });
      return { ok: true, value: { version: version + 1, save: { state: 'unsaved', savedAt: null }, notes: body.notes } };
    },
    getEntity: async (ref) => ({ ok: true, value: nodeOf(ref.sourceId, ref.entityType, ref.stableId) }),
  });
  return { asked, writes, client };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('opening an investigation whose draft holds more than its first entity', () => {
  it('shows every entity the draft names, with its layout, positions, pins, hidden entities and viewport', async () => {
    const draft = draftOf(['A-1', 'B', 'C'], { layout: 'radial', viewport: { zoom: 2, x: 5, y: 6 } }, { B: { x: 10, y: 20, pinned: true }, C: { hidden: true } });
    const { client, asked } = rig(draft);
    const state = createClientState();
    expect(await openById(client, state, INVESTIGATION_A, CONTEXT)).toEqual({ kind: 'shown', id: INVESTIGATION_A, activation: 'fresh' });
    expect(asked).toHaveLength(1);
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual(['A-1', 'B', 'C']);
    const presentation = state.presentation.view.getState();
    const key = (id: string) => elementKey({ sourceId: 'source-a', entityType: 'kind-a', stableId: id });
    expect(presentation.layout).toBe('radial');
    expect(presentation.positions.get(key('B'))).toEqual({ x: 10, y: 20 });
    expect(presentation.pins.has(key('B'))).toBe(true);
    expect(presentation.hidden.has(key('C'))).toBe(true);
    expect(presentation.viewport).toEqual({ zoom: 2, x: 5, y: 6 });
  });

  it('reads them in calls of at most the number one call takes, and shows nothing until all are in', async () => {
    const ids = Array.from({ length: 2 * MAX_READ_REFS + 50 }, (_unused, index) => `E-${index}`);
    const state = createClientState();
    let during: string | null | undefined = 'untouched';
    const { client, asked } = rig(draftOf(ids), [], false, () => {
      if (during === 'untouched') during = state.investigation.getState().id;
    });
    await openById(client, state, INVESTIGATION_A, CONTEXT);
    expect(asked.map((call) => call.entities.length)).toEqual([MAX_READ_REFS, MAX_READ_REFS, 50]);
    expect(during).toBeNull();
    expect(state.loadedGraph().nodes).toHaveLength(ids.length);
  });

  it('shows the rest and says so when some items are not available, and keeps those items in the draft on the next write', async () => {
    const { client, writes } = rig(draftOf(['A-1', 'B', 'C']), ['B']);
    const state = createClientState();
    expect(await openById(client, state, INVESTIGATION_A, CONTEXT)).toEqual({ kind: 'shown', id: INVESTIGATION_A, activation: 'fresh', someMissing: true });
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual(['A-1', 'C']);
    state.presentation.setPosition(elementKey({ sourceId: 'source-a', entityType: 'kind-a', stableId: 'C' }), { x: 1, y: 2 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.version).toBe(4);
    expect(writes[0]?.body.queryContext.loaded.nodes.map((node) => node.id)).toEqual(['A-1', 'C', 'B']);
    expect(writes[0]?.body.notes).toBe('a note');
  });

  it('fails without showing anything, and writes nothing, when a read fails', async () => {
    const { client, writes } = rig(draftOf(['A-1', 'B']), [], true);
    const state = createClientState();
    expect(await openById(client, state, INVESTIGATION_A, CONTEXT)).toMatchObject({ kind: 'failed', failure: { code: 'QUERY_TIMEOUT' } });
    expect(state.investigation.getState().id).toBeNull();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(writes).toHaveLength(0);
  });

  it('resumes an investigation the session holds without a read', async () => {
    const { client, asked } = rig(draftOf(['A-1', 'B']));
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, CONTEXT);
    expect(await openById(client, state, INVESTIGATION_A, CONTEXT)).toMatchObject({ kind: 'shown', activation: 'current' });
    expect(asked).toHaveLength(1);
  });

  it('asks for the personal-data fields to be masked when the session does', async () => {
    const { client, asked } = rig(draftOf(['A-1', 'B']));
    await openById(client, createClientState(), INVESTIGATION_A, { principalId: 'principal-1', mask: true });
    expect(asked[0]?.mask).toBe(true);
  });

  it('restores the draft of an investigation that was resumed through a new open, and a write after it does not shorten the draft', async () => {
    const { client, writes } = rig(draftOf(['A-1', 'B', 'C']));
    const reused = { ...client, openInvestigation: async () => ({ ok: true as const, value: openedOf(investigation, nodeOf('source-a', 'kind-a', 'A-1'), false) }) };
    const state = createClientState();
    const outcome = await openEntity(reused, state, { sourceId: 'source-a', caseRef: 'CASE-1', entity: { sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' } }, CONTEXT);
    expect(outcome).toMatchObject({ kind: 'shown', created: false });
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual(['A-1', 'B', 'C']);
    state.presentation.setPosition(elementKey({ sourceId: 'source-a', entityType: 'kind-a', stableId: 'B' }), { x: 3, y: 3 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes[0]?.body.queryContext.loaded.nodes.map((node) => node.id)).toEqual(['A-1', 'B', 'C']);
  });

  it('writes with the version of the draft a new investigation was made with', async () => {
    const { client, writes } = rig(draftOf(['A-1']));
    const created = { ...client, openInvestigation: async () => ({ ok: true as const, value: { ...openedOf(investigation, nodeOf('source-a', 'kind-a', 'A-1'), true), draft: { version: 1, notes: null, basedOnViewId: null } } }) };
    const state = createClientState();
    await openEntity(created, state, { sourceId: 'source-a', entity: { sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' } }, CONTEXT);
    state.presentation.setPosition(elementKey({ sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' }), { x: 9, y: 9 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes[0]?.version).toBe(1);
  });

  it('restores a draft whose only change is the layout, and writes it back with that layout', async () => {
    const { client, asked, writes } = rig(draftOf(['A-1'], { layout: 'grid' }));
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, CONTEXT);
    expect(asked).toHaveLength(1);
    expect(state.presentation.view.getState().layout).toBe('grid');
    state.presentation.setPosition(elementKey({ sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' }), { x: 1, y: 1 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes[0]?.body.layout.layout).toBe('grid');
  });

  it('restores a draft with only its first entity and a group, and does not lose the group on the first write', async () => {
    const stored = draftOf(['A-1']);
    const groups = [{ id: 'g1', label: 'One', by: 'manual', members: [{ t: 'kind-a', id: 'A-1' }] }];
    const { client, asked, writes } = rig({ ...stored, layout: { ...stored.layout, groups, nodes: stored.layout.nodes.map((node) => ({ ...node, groupId: 'g1' })) } });
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, CONTEXT);
    expect(asked).toHaveLength(1);
    state.presentation.setPosition(elementKey({ sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' }), { x: 1, y: 1 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes[0]?.body.layout.groups).toEqual(groups);
    expect(writes[0]?.body.layout.nodes.map((node) => node.groupId)).toEqual(['g1']);
  });

  it('restores a draft whose query context names another entity than its first, and keeps that entity on the first write', async () => {
    const stored = draftOf(['A-1']);
    const { client, asked, writes } = rig({ ...stored, queryContext: { ...stored.queryContext, loaded: { ...stored.queryContext.loaded, nodes: [...stored.queryContext.loaded.nodes, { t: 'kind-a', id: 'Z' }] } } });
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, CONTEXT);
    expect(asked).toHaveLength(1);
    state.presentation.setPosition(elementKey({ sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' }), { x: 1, y: 1 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes[0]?.body.queryContext.loaded.nodes.map((node) => node.id)).toContain('Z');
  });

  it('writes back a property filter, a time filter and an expansion the draft held, though it shows none of them and its only entity is the first', async () => {
    const stored = draftOf(['A-1']);
    const properties = [{ key: 'prop-x', op: 'gte', values: ['10'] }];
    const expansions = [{ from: { t: 'kind-a', id: 'A-1' }, relTypes: ['rel-a'], neighborTypes: [], window: null, sort: 'default', pages: 2 }];
    const draft = { ...stored, queryContext: { ...stored.queryContext, expansions, filters: { ...NO_FILTERS, time: { from: '2024-01-01' }, properties } } };
    const { client, asked, writes } = rig(draft);
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, CONTEXT);
    // a draft that holds a filter is not the draft an open writes, so it is restored and not started afresh
    expect(asked).toHaveLength(1);
    state.presentation.setMappedTypes({ entityTypes: ['kind-a'], relationshipTypes: [] });
    state.presentation.setPosition(elementKey({ sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' }), { x: 1, y: 1 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes[0]?.body.queryContext.filters).toEqual({ ...NO_FILTERS, time: { from: '2024-01-01' }, properties });
    expect(writes[0]?.body.queryContext.expansions).toEqual(expansions);
  });
});

describe('opening another investigation while the changes of the one shown cannot be written', () => {
  const other = investigationOf(INVESTIGATION_B, 'source-a', 'kind-a', 'BZ-1');
  const A_REF = { sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' };

  async function shownWithUnsavedChanges(saves: () => ApiResult<{ version: number; save: { state: 'unsaved'; savedAt: null }; notes: null }>) {
    const { client } = knowing([{ investigation, node: nodeOf('source-a', 'kind-a', 'A-1') }, { investigation: other, node: nodeOf('source-a', 'kind-a', 'BZ-1') }], { saveDraft: async () => saves() });
    const state = createClientState();
    await openEntity(client, state, { sourceId: 'source-a', entity: A_REF }, CONTEXT);
    state.presentation.setPosition(elementKey(A_REF), { x: 4, y: 4 });
    return { client, state };
  }

  it('writes the draft first, and opens the other once it is saved', async () => {
    let saved = 0;
    const { client, state } = await shownWithUnsavedChanges(() => ({ ok: true, value: { version: ++saved + 1, save: { state: 'unsaved', savedAt: null }, notes: null } }));
    const outcome = await openById(client, state, INVESTIGATION_B, CONTEXT);
    expect(outcome).toMatchObject({ kind: 'shown', id: INVESTIGATION_B });
    expect(saved).toBe(1);
  });

  it('keeps the person where they are until they save again or leave anyway, and opens nothing before', async () => {
    let up = false;
    const { client, state } = await shownWithUnsavedChanges(() => (up ? { ok: true, value: { version: 2, save: { state: 'unsaved', savedAt: null }, notes: null } } : { ok: false, failure: { code: 'INTERNAL_ERROR', message: 'x', retryable: true, traceId: 't' } }));
    let outcome: Awaited<ReturnType<typeof openById>> | undefined;
    void openById(client, state, INVESTIGATION_B, CONTEXT).then((done) => (outcome = done));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBeUndefined();
    expect(state.investigation.getState().id).toBe(INVESTIGATION_A);
    expect(draftSyncOf(state, client).leaving.getState()).toBe(true);
    up = true;
    draftSyncOf(state, client).retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatchObject({ kind: 'shown', id: INVESTIGATION_B });
  });

  it('opens the other when the person leaves anyway, and nothing when the open is cancelled', async () => {
    const down = (): ApiResult<{ version: number; save: { state: 'unsaved'; savedAt: null }; notes: null }> => ({ ok: false, failure: { code: 'INTERNAL_ERROR', message: 'x', retryable: true, traceId: 't' } });
    const left = await shownWithUnsavedChanges(down);
    let outcome: Awaited<ReturnType<typeof openById>> | undefined;
    void openById(left.client, left.state, INVESTIGATION_B, CONTEXT).then((done) => (outcome = done));
    await vi.advanceTimersByTimeAsync(0);
    draftSyncOf(left.state, left.client).leaveAnyway();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatchObject({ kind: 'shown', id: INVESTIGATION_B });

    const stayed = await shownWithUnsavedChanges(down);
    const controller = new AbortController();
    const cancelled = openById(stayed.client, stayed.state, INVESTIGATION_B, CONTEXT, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await cancelled).toEqual({ kind: 'held' });
    expect(stayed.state.investigation.getState().id).toBe(INVESTIGATION_A);
  });

  it('does the same before an entity is opened', async () => {
    const down = (): ApiResult<{ version: number; save: { state: 'unsaved'; savedAt: null }; notes: null }> => ({ ok: false, failure: { code: 'INTERNAL_ERROR', message: 'x', retryable: true, traceId: 't' } });
    const { client, state } = await shownWithUnsavedChanges(down);
    let outcome: Awaited<ReturnType<typeof openEntity>> | undefined;
    void openEntity(client, state, { sourceId: 'source-a', entity: { sourceId: 'source-a', entityType: 'kind-a', stableId: 'BZ-1' } }, CONTEXT).then((done) => (outcome = done));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBeUndefined();
    draftSyncOf(state, client).leaveAnyway();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatchObject({ kind: 'shown', id: INVESTIGATION_B });
  });
});

describe('the saved state of an investigation that is opened', () => {
  const opening = draftOf(['A-1']);

  async function openedWith(save: InvestigationResponse['save']) {
    const { client } = knowing([], {
      getInvestigation: async () => ({ ok: true, value: { investigation, draft: opening, save } }),
      getEntity: async (ref) => ({ ok: true, value: nodeOf(ref.sourceId, ref.entityType, ref.stableId) }),
    });
    const state = createClientState();
    expect((await openById(client, state, INVESTIGATION_A, CONTEXT)).kind).toBe('shown');
    return state;
  }

  it('shows the time of the view the draft equals when the server says it is saved', async () => {
    const state = await openedWith({ state: 'saved', savedAt: '2026-11-08T09:30:00.000Z' });
    expect(state.investigation.getState().record?.save).toEqual({ kind: 'saved', at: '2026-11-08T09:30:00.000Z' });
  });

  it('shows Unsaved when the server says the draft equals no view, as when the view it was based on is gone', async () => {
    const state = await openedWith({ state: 'unsaved', savedAt: null });
    expect(state.investigation.getState().record?.save).toEqual({ kind: 'unsaved' });
  });
});
