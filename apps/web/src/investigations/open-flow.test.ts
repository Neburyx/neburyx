import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf, openedOf, type KnownInvestigation } from './test-data.js';
import { openById, openEntity } from './open-flow.js';

const CONTEXT = { principalId: 'principal-1', mask: false };
const MASKED = { principalId: 'principal-1', mask: true };
const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1'), node: nodeOf('source-b', 'kind-a', 'C-1') };

describe('opening an investigation by its identifier', () => {
  it('reads the investigation and its first entity, then shows both with the record in the header and the entity as the whole graph', async () => {
    const { client, calls } = knowing([A]);
    const state = createClientState();
    expect(await openById(client, state, INVESTIGATION_A, CONTEXT)).toEqual({ kind: 'shown', id: INVESTIGATION_A, activation: 'fresh' });
    expect(calls).toEqual({ getInvestigation: [INVESTIGATION_A], getEntity: [1], openInvestigation: [] });
    expect(state.investigation.getState()).toMatchObject({ id: INVESTIGATION_A, sourceId: 'source-a', record: { title: 'kind-a A-1', caseRef: 'CASE-1', save: { kind: 'unsaved' } } });
    expect(state.loadedGraph().nodes.map((node) => node.ref.stableId)).toEqual(['A-1']);
  });

  it('makes no read for an investigation the session holds, whether it is the one shown or one set aside', async () => {
    const { client, calls } = knowing([A, B]);
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, CONTEXT);
    await openById(client, state, INVESTIGATION_B, CONTEXT);
    const reads = JSON.stringify(calls);
    expect(await openById(client, state, INVESTIGATION_A, CONTEXT)).toMatchObject({ kind: 'shown', activation: 'resumed' });
    expect(await openById(client, state, INVESTIGATION_A, CONTEXT)).toMatchObject({ kind: 'shown', activation: 'current' });
    expect(JSON.stringify(calls)).toBe(reads);
  });

  it.each(['removed', 'repointed'] as const)('reads no entity and shows nothing when the source is %s', async (sourceState) => {
    const { client, calls } = knowing([{ ...A, investigation: { ...A.investigation, sourceState } }]);
    const state = createClientState();
    const outcome = await openById(client, state, INVESTIGATION_A, CONTEXT);
    expect(outcome).toMatchObject({ kind: 'source-unavailable' });
    expect(calls.getEntity).toEqual([]);
    expect(state.investigation.getState().id).toBeNull();
  });

  it('answers NOT_FOUND for an investigation the API does not know, and changes nothing that is on screen', async () => {
    const { client } = knowing([A]);
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, CONTEXT);
    const before = state.investigation.getState();
    expect(await openById(client, state, INVESTIGATION_B, CONTEXT)).toMatchObject({ kind: 'failed', failure: { code: 'NOT_FOUND' } });
    expect(state.investigation.getState()).toBe(before);
  });

  it('keeps what is on screen when the investigation is read but its entity is not, and again when the API is down', async () => {
    const { client } = knowing([A, { investigation: B.investigation, node: nodeOf('source-b', 'kind-a', 'C-missing') }]);
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, CONTEXT);
    const before = state.investigation.getState();
    expect(await openById(client, state, INVESTIGATION_B, CONTEXT)).toMatchObject({ kind: 'failed', failure: { code: 'NOT_FOUND' } });
    expect(state.investigation.getState()).toBe(before);
    const down = knowing([], { getInvestigation: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    expect(await openById(down.client, state, INVESTIGATION_B, CONTEXT)).toMatchObject({ kind: 'failed', failure: { code: 'NETWORK_UNAVAILABLE' } });
    expect(state.investigation.getState()).toBe(before);
  });

  it('refuses an entity of another source than the investigation’s', async () => {
    const { client } = knowing([A], { getEntity: async () => ({ ok: true, value: nodeOf('source-b', 'kind-a', 'A-1') }) });
    const state = createClientState();
    expect(await openById(client, state, INVESTIGATION_A, CONTEXT)).toMatchObject({ kind: 'failed', failure: { code: 'SCHEMA_MISMATCH' } });
    expect(state.investigation.getState().id).toBeNull();
  });

  it('shows nothing when the page was left before the answer came', async () => {
    const { client } = knowing([A]);
    const state = createClientState();
    const controller = new AbortController();
    const pending = openById(client, state, INVESTIGATION_A, CONTEXT, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ kind: 'failed', failure: { code: 'ABORTED' } });
    expect(state.investigation.getState().id).toBeNull();
  });
});

describe('opening an entity', () => {
  const request = { sourceId: 'source-a', entity: { sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' } };

  it('shows the entity the answer carries and reads nothing more, so the page that follows reads nothing', async () => {
    const { client, calls } = knowing([A]);
    const state = createClientState();
    const outcome = await openEntity(client, state, request, CONTEXT);
    expect(outcome).toMatchObject({ kind: 'shown', id: INVESTIGATION_A, created: true });
    expect(calls).toEqual({ openInvestigation: [1], getEntity: [], getInvestigation: [] });
    expect(await openById(client, state, INVESTIGATION_A, CONTEXT)).toMatchObject({ kind: 'shown', activation: 'current' });
    expect(calls.getEntity).toEqual([]);
    expect(calls.getInvestigation).toEqual([]);
  });

  it('reports a resumed investigation as not created', async () => {
    const { client } = knowing([A], { openInvestigation: async () => ({ ok: true, value: openedOf(A.investigation, A.node, false) }) });
    expect(await openEntity(client, createClientState(), request, CONTEXT)).toMatchObject({ kind: 'shown', created: false });
  });

  it('shows nothing when the investigation that was resumed has a source that is not as it was', async () => {
    const { client } = knowing([A], { openInvestigation: async () => ({ ok: true, value: openedOf({ ...A.investigation, sourceState: 'repointed' }, undefined, false) }) });
    const state = createClientState();
    expect(await openEntity(client, state, request, CONTEXT)).toMatchObject({ kind: 'source-unavailable' });
    expect(state.investigation.getState().id).toBeNull();
  });

  it('gives the failure of the API and changes nothing', async () => {
    const { client } = knowing([]);
    const state = createClientState();
    expect(await openEntity(client, state, request, CONTEXT)).toMatchObject({ kind: 'failed', failure: { code: 'NOT_FOUND' } });
    expect(state.investigation.getState().id).toBeNull();
  });
});

describe('opening an investigation for a mask', () => {
  const plain = nodeOf('source-a', 'kind-a', 'A-1', 'Ana Silva');
  const hidden = nodeOf('source-a', 'kind-a', 'A-1', 'A•••');
  const known: KnownInvestigation = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1'), node: plain, masked: hidden };
  const other: KnownInvestigation = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1'), node: nodeOf('source-b', 'kind-a', 'C-1') };
  const shownTitle = (state: ReturnType<typeof createClientState>) => state.loadedGraph().nodes[0]?.display.title;
  const request = { sourceId: 'source-a', entity: { sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' } };

  it('asks the API for the mask it is given and stores the answer under that mask', async () => {
    const { client } = knowing([known]);
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, MASKED);
    expect(shownTitle(state)).toBe('A•••');
    expect(state.investigation.getState().resultKeys.map((key) => key.mask)).toEqual([true]);
    const opened = createClientState();
    await openEntity(client, opened, request, MASKED);
    expect(shownTitle(opened)).toBe('A•••');
    expect(opened.investigation.getState().resultKeys.map((key) => key.mask)).toEqual([true]);
  });

  it.each([
    ['plain, then masked', CONTEXT, MASKED, 'A•••'],
    ['masked, then plain', MASKED, CONTEXT, 'Ana Silva'],
  ])('reads again and shows the other mask when the investigation shown is %s', async (_name, first, second, title) => {
    const { client, calls } = knowing([known]);
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, first);
    expect(await openById(client, state, INVESTIGATION_A, second)).toMatchObject({ kind: 'shown', activation: 'fresh' });
    expect(calls.getEntity).toHaveLength(2);
    expect(shownTitle(state)).toBe(title);
    expect(await openById(client, state, INVESTIGATION_A, second)).toMatchObject({ activation: 'current' });
    expect(calls.getEntity).toHaveLength(2);
  });

  it.each([
    ['plain, then masked', CONTEXT, MASKED, 'A•••'],
    ['masked, then plain', MASKED, CONTEXT, 'Ana Silva'],
  ])('reads again and shows the other mask when the investigation set aside was read %s', async (_name, first, second, title) => {
    const { client, calls } = knowing([known, other]);
    const state = createClientState();
    await openById(client, state, INVESTIGATION_A, first);
    await openById(client, state, INVESTIGATION_B, first);
    expect(await openById(client, state, INVESTIGATION_A, second)).toMatchObject({ kind: 'shown', activation: 'fresh' });
    expect(shownTitle(state)).toBe(title);
    expect(calls.getEntity).toHaveLength(3);
    expect(state.holds(INVESTIGATION_B, first.mask)).toBe(true);
  });

  it('shows an entity opened for the other mask than the one the investigation was held for', async () => {
    const { client } = knowing([known]);
    const state = createClientState();
    await openEntity(client, state, request, CONTEXT);
    expect(await openEntity(client, state, request, MASKED)).toMatchObject({ kind: 'shown', created: true });
    expect(shownTitle(state)).toBe('A•••');
    expect(state.loadedGraph().nodes.map((node) => JSON.stringify(node))).not.toContain('Ana Silva');
  });
});
