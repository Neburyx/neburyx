import type { InvestigationResponse, ReadRefsRequest } from '@neburyx/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { AUTOSAVE_DELAY_MS, draftSyncOf } from '../draft/draft-sync.js';
import { mappingNoticesOf } from '../draft/mapping-notice.js';
import { isUnmappedEdge, isUnmappedNode } from '../draft/unmapped.js';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { openById } from './open-flow.js';
import { INVESTIGATION_A, investigationOf, knowing, nodeOf } from './test-data.js';

const CONTEXT = { principalId: 'principal-1', mask: false };
const investigation = investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1');
const NO_FILTERS = { entityTypes: [], relTypes: [], time: null, properties: [] };
const keyOf = (type: string, id: string) => elementKey({ sourceId: 'source-a', entityType: type, stableId: id });

type Edge = InvestigationResponse['draft']['queryContext']['loaded']['edges'][number];

function answer(nodes: { t: string; id: string; extra?: Record<string, unknown> }[], edges: Edge[] = [], extra: Partial<InvestigationResponse> = {}, status: 'open' | 'closed' = 'open'): InvestigationResponse {
  return {
    investigation: { ...investigation, status },
    draft: {
      version: 4,
      notes: null,
      basedOnViewId: null,
      layout: { schemaVersion: 1, layout: 'force', nodes: nodes.map((node) => ({ t: node.t, id: node.id, pinned: false, hidden: false, groupId: null, ...node.extra })), edges: edges.map((edge) => ({ ...edge, hidden: false })), groups: [] },
      queryContext: { schemaVersion: 1, loaded: { nodes: nodes.map(({ t, id }) => ({ t, id })), edges }, expansions: [], filters: NO_FILTERS },
    },
    save: { state: 'unsaved', savedAt: null },
    ...extra,
  };
}

function rig(body: InvestigationResponse) {
  const asked: ReadRefsRequest[] = [];
  const entityReads: string[] = [];
  const writes: { version: number; body: Parameters<ReturnType<typeof knowing>['client']['saveDraft']>[2] }[] = [];
  const { client } = knowing([], {
    getInvestigation: async () => ({ ok: true, value: body }),
    readRefs: async (request): Promise<ApiResult<{ nodes: ReturnType<typeof nodeOf>[]; edges: never[]; missing: { entities: never[]; edges: never[] } }>> => {
      asked.push(request);
      return { ok: true, value: { nodes: request.entities.map((ref) => nodeOf(ref.sourceId, ref.entityType, ref.stableId)), edges: [], missing: { entities: [], edges: [] } } };
    },
    getEntity: async (ref) => {
      entityReads.push(ref.entityType);
      return { ok: true, value: nodeOf(ref.sourceId, ref.entityType, ref.stableId) };
    },
    saveDraft: async (_id, version, draft) => {
      writes.push({ version, body: draft });
      return { ok: true, value: { version: version + 1, save: { state: 'unsaved', savedAt: null }, notes: draft.notes } };
    },
  });
  return { client, asked, entityReads, writes };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('opening a draft that holds items the mapping no longer covers', () => {
  it('shows them as placeholders at their saved place, asks the source only for the rest, and does not count them as unavailable', async () => {
    const body = answer([{ t: 'kind-a', id: 'A-1' }, { t: 'gone', id: 'X', extra: { x: 7, y: 8, pinned: true, hidden: true } }], [], { unmapped: { nodes: [{ t: 'gone', id: 'X' }], edges: [] } });
    const { client, asked } = rig(body);
    const state = createClientState();
    expect(await openById(client, state, INVESTIGATION_A, CONTEXT)).toEqual({ kind: 'shown', id: INVESTIGATION_A, activation: 'fresh' });
    expect(asked.flatMap((call) => call.entities.map((ref) => ref.entityType))).toEqual(['kind-a']);
    const placeholder = state.loadedGraph().nodes.find((node) => isUnmappedNode(node));
    expect(placeholder).toMatchObject({ display: { title: 'Unmapped item' }, properties: [] });
    const presentation = state.presentation.view.getState();
    expect(presentation.positions.get(keyOf('gone', 'X'))).toEqual({ x: 7, y: 8 });
    expect(presentation.pins.has(keyOf('gone', 'X'))).toBe(true);
    expect(presentation.hidden.has(keyOf('gone', 'X'))).toBe(true);
  });

  it('keeps the placeholders in the draft on the next write', async () => {
    const body = answer([{ t: 'kind-a', id: 'A-1' }, { t: 'gone', id: 'X' }], [], { unmapped: { nodes: [{ t: 'gone', id: 'X' }], edges: [] } });
    const { client, writes } = rig(body);
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, CONTEXT);
    state.presentation.setPosition(keyOf('kind-a', 'A-1'), { x: 1, y: 2 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes.at(-1)?.body.queryContext.loaded.nodes.map((node) => `${node.t}:${node.id}`)).toEqual(['kind-a:A-1', 'gone:X']);
  });

  it.each([
    ['a stored relationship', { t: 'REL', from: { t: 'kind-a', id: 'A-1' }, to: { t: 'kind-a', id: 'B' }, id: 'r1' }],
    ['an aggregate relationship', { t: 'REL', from: { t: 'kind-a', id: 'A-1' }, to: { t: 'kind-a', id: 'B' } }],
    ['a derived relationship', { t: 'rule-type', from: { t: 'kind-a', id: 'A-1' }, to: { t: 'kind-a', id: 'B' }, ruleId: 'old-rule' }],
  ] as const)('draws %s of an unmapped type as a placeholder, reads nothing for it, and writes it back unchanged', async (_name, edge) => {
    const body = answer([{ t: 'kind-a', id: 'A-1' }, { t: 'kind-a', id: 'B' }], [edge], { unmapped: { nodes: [], edges: [edge] } });
    const { client, asked, writes } = rig(body);
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, CONTEXT);
    expect(asked.every((call) => call.edges.length === 0 && call.aggregates.length === 0 && call.derived.length === 0)).toBe(true);
    expect(state.loadedGraph().edges.filter(isUnmappedEdge)).toHaveLength(1);
    state.presentation.setPosition(keyOf('kind-a', 'A-1'), { x: 1, y: 2 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes.at(-1)?.body.queryContext.loaded.edges).toEqual([edge]);
  });

  it('shows a placeholder, with no read of the starting entity, when the type of the starting entity is gone', async () => {
    const body = answer([{ t: 'kind-a', id: 'A-1' }], [], { unmapped: { nodes: [{ t: 'kind-a', id: 'A-1' }], edges: [] } });
    const { client, entityReads, asked } = rig(body);
    const state = createClientState();
    expect(await openById(client, state, INVESTIGATION_A, CONTEXT)).toMatchObject({ kind: 'shown' });
    expect(entityReads).toEqual([]);
    expect(asked.flatMap((call) => call.entities)).toEqual([]);
    expect(state.loadedGraph().nodes.every((node) => isUnmappedNode(node))).toBe(true);
  });
});

describe('opening a draft written under another mapping', () => {
  const changed = (extra: Partial<InvestigationResponse> = {}, status: 'open' | 'closed' = 'open') => answer([{ t: 'kind-a', id: 'A-1' }], [], { mappingChange: { droppedFilters: [{ name: 'ghost', reason: 'property-removed' }] }, ...extra }, status);

  it('records what was dropped for the banner and sends one write once the banner has been shown, stored under the current mapping', async () => {
    const { client, writes } = rig(changed());
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, CONTEXT);
    expect(mappingNoticesOf(state).notice.getState()).toMatchObject({ investigationId: INVESTIGATION_A, droppedFilters: [{ name: 'ghost', reason: 'property-removed' }], hasUnmapped: false, canChange: true });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(writes).toHaveLength(0);
    mappingNoticesOf(state).notice.getState()?.onShown?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.version).toBe(4);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(writes).toHaveLength(1);
  });

  it('writes back, in its one write, the property filters the server kept, and none of the one it dropped', async () => {
    const body = changed();
    const kept = [{ key: 'region', op: 'eq', values: ['north'] }];
    const { client, writes } = rig({ ...body, draft: { ...body.draft, queryContext: { ...body.draft.queryContext, filters: { ...NO_FILTERS, properties: kept } } } });
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, CONTEXT);
    mappingNoticesOf(state).notice.getState()?.onShown?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body.queryContext.filters.properties).toEqual(kept);
  });

  it('sends no write for an investigation that cannot be changed, and still records the notice', async () => {
    const { client, writes } = rig(changed({}, 'closed'));
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, CONTEXT);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(writes).toHaveLength(0);
    expect(mappingNoticesOf(state).notice.getState()).toMatchObject({ investigationId: INVESTIGATION_A, canChange: false });
    expect(mappingNoticesOf(state).notice.getState()?.onShown).toBeUndefined();
  });

  it('records no notice and sends no write when the mapping did not change', async () => {
    const { client, writes } = rig(answer([{ t: 'kind-a', id: 'A-1' }]));
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, CONTEXT);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(writes).toHaveLength(0);
    expect(mappingNoticesOf(state).notice.getState()).toBeUndefined();
  });

  it('keeps the draft and shows the failure status when the write fails, with the notice still recorded', async () => {
    const rigged = rig(changed());
    const failing = { ...rigged.client, saveDraft: async (): Promise<ApiResult<never>> => ({ ok: false, failure: { code: 'SOURCE_UNAVAILABLE', message: 'x', retryable: true, traceId: 't' } }) };
    const state = createClientState();
    await openById(failing, state, INVESTIGATION_A, CONTEXT);
    mappingNoticesOf(state).notice.getState()?.onShown?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(draftSyncOf(state, failing).status.getState().kind).toBe('failing');
    expect(mappingNoticesOf(state).notice.getState()).toMatchObject({ investigationId: INVESTIGATION_A });
    expect(state.loadedGraph().nodes).toHaveLength(1);
  });
});
