import { MAX_READ_REFS, type InvestigationResponse, type ReadRefsRequest } from '@neburyx/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { AUTOSAVE_DELAY_MS } from '../draft/draft-sync.js';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { openById, openEntity } from './open-flow.js';
import { INVESTIGATION_A, investigationOf, knowing, nodeOf, openedOf } from './test-data.js';

const CONTEXT = { principalId: 'principal-1', mask: false };
const investigation = investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1');
const entry = (id: string, extra: Record<string, unknown> = {}) => ({ t: 'kind-a', id, pinned: false, hidden: false, groupId: null, ...extra });
const NO_FILTERS = { entityTypes: [], relTypes: [], time: null, properties: [] };

function draftOf(ids: readonly string[], layoutExtra: Record<string, unknown> = {}, nodeExtras: Record<string, Record<string, unknown>> = {}, edges: InvestigationResponse['draft']['queryContext']['loaded']['edges'] = []): InvestigationResponse['draft'] {
  return {
    version: 4,
    notes: 'a note',
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
    getInvestigation: async () => ({ ok: true, value: { investigation, draft } }),
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
    const created = { ...client, openInvestigation: async () => ({ ok: true as const, value: { ...openedOf(investigation, nodeOf('source-a', 'kind-a', 'A-1'), true), draft: { version: 1 } } }) };
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
});
