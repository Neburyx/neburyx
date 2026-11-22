import type { EdgeRef, ElementRef, GraphEdge, GraphNode, ReadRefsRequest, ReadRefsResponse } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { placeholderNode } from '../draft/unmapped.js';
import { failure } from '../patterns/patterns-kit.js';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { edge, edgeRef, key, node, ref } from '../state/test-data.js';
import { maskSwitchOf } from './mask-switch.js';

const SOURCE = 'source-a';
const at = (id: string): ElementRef => ref(SOURCE, 'type-a', id);
const masked = (id: string): GraphNode => ({ ...node(SOURCE, id), display: { title: `M${id}`, type: 'type-a' } });
const failed: ApiResult<ReadRefsResponse> = { ok: false, failure: failure('RATE_LIMITED') };

interface Waiting {
  readonly request: ReadRefsRequest;
  readonly signal: AbortSignal | undefined;
  readonly answer: (result: ApiResult<ReadRefsResponse>) => void;
}

function rig(ids: readonly string[] = ['n1', 'n2', 'n3'], links: ReadonlyArray<readonly [string, string, string]> = [['e1', 'n1', 'n2']]) {
  const waiting: Waiting[] = [];
  const client = fakeClient({ readRefs: (request, signal) => new Promise((resolve) => void waiting.push({ request, signal, answer: resolve })) });
  const state = createClientState();
  state.bindSource(SOURCE);
  const nodes = ids.map((id) => node(SOURCE, id));
  const edges: GraphEdge[] = links.map(([id, from, to]) => edge(SOURCE, id, from, to));
  state.putResult(key(SOURCE), { sourceId: SOURCE, nodes, edges });
  state.setLoaded([key(SOURCE)], nodes.map((held) => held.ref), edges.map((held) => held.ref));
  return { state, client, waiting, maskSwitch: maskSwitchOf(state, client) };
}

const answered = (nodes: readonly GraphNode[], edges: readonly GraphEdge[] = [], missing: ReadRefsResponse['missing'] = { entities: [], edges: [] }): ApiResult<ReadRefsResponse> => ({ ok: true, value: { nodes: [...nodes], edges: [...edges], missing } });
const settle = () => new Promise<void>((done) => setTimeout(done, 0));
const answerCalls = async (waiting: readonly Waiting[], from: number, ...results: ReadonlyArray<ApiResult<ReadRefsResponse>>): Promise<void> => {
  for (const [at, result] of results.entries()) {
    await settle();
    waiting[from + at]?.answer(result);
  }
  await settle();
};
const NONE = answered([]);

describe('reading the view again after the masking setting changes', () => {
  it('shows an error with nothing held, and no value of either setting, when the read fails; Try again reads with the setting as it is', async () => {
    const { state, waiting, maskSwitch } = rig();
    maskSwitch.turn(true);
    waiting[0]?.answer(failed);
    await settle();
    expect(maskSwitch.status.getState()).toMatchObject({ kind: 'failed', failure: { code: 'RATE_LIMITED' } });
    expect(state.loadedGraph().nodes).toEqual([]);
    expect(state.server.getState().results.size).toBe(0);
    expect(state.rereading.getState()).toBe(true);
    maskSwitch.retry();
    expect(waiting).toHaveLength(2);
    expect(waiting[1]?.request.mask).toBe(true);
    await answerCalls(waiting, 1, answered([masked('n1'), masked('n2'), masked('n3')]), answered([], [edge(SOURCE, 'e1', 'n1', 'n2')]));
    expect(maskSwitch.status.getState()).toEqual({ kind: 'idle' });
    expect(state.rereading.getState()).toBe(false);
    expect(state.loadedGraph().nodes.map((held) => held.display.title)).toEqual(['Mn1', 'Mn2', 'Mn3']);
  });

  it('discards the answer of a change that a newer change replaced, and aborts its read', async () => {
    const { state, waiting, maskSwitch } = rig();
    maskSwitch.turn(true);
    maskSwitch.turn(false);
    expect(waiting[0]?.signal?.aborted).toBe(true);
    waiting[0]?.answer(answered([masked('n1'), masked('n2'), masked('n3')]));
    await settle();
    expect(state.loadedGraph().nodes).toEqual([]);
    expect(waiting[1]?.request.mask).toBeUndefined();
    await answerCalls(waiting, 1, answered([node(SOURCE, 'n1'), node(SOURCE, 'n2'), node(SOURCE, 'n3')]), answered([], [edge(SOURCE, 'e1', 'n1', 'n2')]));
    expect(state.loadedGraph().nodes.map((held) => held.display.title)).toEqual(['n1', 'n2', 'n3']);
    expect(state.server.getState().results.size).toBe(1);
  });

  it('drops an item the answer lists as missing from the view and says some items are unavailable', async () => {
    const { state, waiting, maskSwitch } = rig();
    const { restoreNoticeOf } = await import('../views/restore-notice.js');
    maskSwitch.turn(true);
    await answerCalls(waiting, 0, answered([masked('n1'), masked('n2')], [], { entities: [at('n3')], edges: [] }), answered([], [edge(SOURCE, 'e1', 'n1', 'n2')]));
    expect(state.loadedGraph().nodes.map((held) => held.ref.stableId)).toEqual(['n1', 'n2']);
    expect(restoreNoticeOf(state).missing.getState()).toBe(true);
  });

  it('does not read a placeholder of an unmapped type, and keeps it in the view', async () => {
    const { state, waiting, maskSwitch } = rig(['n1'], []);
    const unmapped = placeholderNode(SOURCE, { t: 'type-gone', id: 'g1' });
    state.putResult({ ...key(SOURCE, 'extra') }, { sourceId: SOURCE, nodes: [unmapped], edges: [] });
    state.setLoaded([key(SOURCE), key(SOURCE, 'extra')], [at('n1'), unmapped.ref], []);
    maskSwitch.turn(true);
    expect(waiting[0]?.request.entities).toEqual([at('n1')]);
    await answerCalls(waiting, 0, answered([masked('n1')]));
    expect(state.loadedGraph().nodes.map((held) => held.ref.stableId).sort()).toEqual(['g1', 'n1']);
  });

  it('reads exactly the references of the view with the new setting and keeps positions, pins, hidden entities and the selection', async () => {
    const aggregate: EdgeRef = { sourceId: SOURCE, aggregate: { type: 'rel-a', from: at('n1'), to: at('n3') } };
    const { state, waiting, maskSwitch } = rig();
    const first = elementKey(at('n1'));
    state.presentation.setPosition(first, { x: 4, y: 5 });
    state.presentation.pin([first]);
    state.presentation.select([elementKey(at('n2'))]);
    state.hide([elementKey(at('n3'))]);
    state.setLoaded(state.investigation.getState().resultKeys, state.investigation.getState().nodeRefs, [...state.investigation.getState().edgeRefs, aggregate]);
    maskSwitch.turn(true);
    expect(state.loadedGraph().nodes).toEqual([]);
    expect(waiting.map((call) => call.request)).toEqual([{ sourceId: SOURCE, mask: true, entities: [at('n1'), at('n2'), at('n3')], edges: [], aggregates: [], derived: [] }]);
    await answerCalls(waiting, 0, answered([masked('n1'), masked('n2'), masked('n3')]), answered([], [edge(SOURCE, 'e1', 'n1', 'n2')]), NONE);
    expect(waiting).toHaveLength(3);
    expect(waiting[1]?.request).toMatchObject({ entities: [], edges: [edgeRef(SOURCE, 'e1')] });
    expect(waiting[2]?.request).toMatchObject({ aggregates: [aggregate] });
    const view = state.presentation.view.getState();
    expect(view.positions.get(first)).toEqual({ x: 4, y: 5 });
    expect([...view.pins]).toEqual([first]);
    expect([...view.hidden]).toEqual([elementKey(at('n3'))]);
    expect([...view.selection]).toEqual([elementKey(at('n2'))]);
    expect(state.loadedGraph().nodes.every((held) => held.display.title.startsWith('M'))).toBe(true);
  });

  it('reads nothing for an empty view, and nothing when the setting is the one it was', () => {
    const { state, waiting, maskSwitch } = rig([], []);
    maskSwitch.turn(true);
    maskSwitch.turn(true);
    expect(waiting).toEqual([]);
    expect(state.rereading.getState()).toBe(false);
    expect(state.mask.getState()).toBe(true);
  });

  it('shows nothing of the answer when another investigation took the place of the one read', async () => {
    const { state, waiting, maskSwitch } = rig();
    maskSwitch.turn(true);
    state.unbindSource();
    state.bindSource('source-b');
    waiting[0]?.answer(answered([masked('n1')]));
    await settle();
    expect(state.server.getState().results.size).toBe(0);
    expect(state.investigation.getState().sourceId).toBe('source-b');
  });

  it.each([
    [100, 1],
    [101, 2],
  ])('reads %i entities in %i call(s) of at most 100 references', async (count, calls) => {
    const ids = Array.from({ length: count }, (_, at) => `n${at}`);
    const { waiting, maskSwitch } = rig(ids, []);
    maskSwitch.turn(true);
    for (let at = 0; at < calls; at += 1) await answerCalls(waiting, at, NONE);
    expect(waiting).toHaveLength(calls);
    expect(waiting.map((call) => call.request.entities.length)).toEqual(calls === 1 ? [100] : [100, 1]);
  });

  it('shows nothing of an earlier chunk when a later one fails', async () => {
    const ids = Array.from({ length: 101 }, (_, at) => `n${at}`);
    const { state, waiting, maskSwitch } = rig(ids, []);
    maskSwitch.turn(true);
    await answerCalls(waiting, 0, answered(ids.slice(0, 100).map(masked)), failed);
    expect(maskSwitch.status.getState()).toMatchObject({ kind: 'failed' });
    expect(state.loadedGraph().nodes).toEqual([]);
    expect(state.server.getState().results.size).toBe(0);
  });

  it('refuses an answer that names another source, and leaves the state as it was', async () => {
    const { state, waiting, maskSwitch } = rig(['n1'], []);
    maskSwitch.turn(true);
    await answerCalls(waiting, 0, answered([node('source-b', 'n1')]));
    expect(maskSwitch.status.getState()).toMatchObject({ kind: 'failed', failure: { code: 'SCHEMA_MISMATCH' } });
    expect(state.server.getState().results.size).toBe(0);
    expect(state.rereading.getState()).toBe(true);
  });

  it('is a failure the person can try again, not a wait that never ends, when the read ended without an answer', async () => {
    const { state, waiting, maskSwitch } = rig();
    maskSwitch.turn(true);
    waiting[0]?.answer({ ok: false, failure: { code: 'ABORTED' } });
    await settle();
    expect(maskSwitch.status.getState()).toMatchObject({ kind: 'failed', failure: { code: 'ABORTED' } });
    expect(state.rereading.getState()).toBe(true);
  });

  it.each(['reading', 'failed'])('leaves nothing of a read that was %s when another investigation takes the place of the one read', async (phase) => {
    const { state, waiting, maskSwitch } = rig(['n1'], []);
    maskSwitch.turn(true);
    if (phase === 'failed') {
      waiting[0]?.answer(failed);
      await settle();
    }
    state.bindSource('source-b');
    expect(maskSwitch.status.getState()).toEqual({ kind: 'idle' });
    if (phase === 'reading') {
      waiting[0]?.answer(answered([masked('n1')]));
      await settle();
      expect(state.server.getState().results.size).toBe(0);
    }
    maskSwitch.turn(false);
    expect(maskSwitch.status.getState()).toEqual({ kind: 'idle' });
  });

  it.each(['repointed', 'removed'] as const)('sends no request for an investigation whose source was %s, and says the read ended', async (sourceState) => {
    const waiting: Waiting[] = [];
    const client = fakeClient({ readRefs: (request, signal) => new Promise((resolve) => void waiting.push({ request, signal, answer: resolve })) });
    const state = createClientState();
    state.bindSource(SOURCE);
    const read = { key: key(SOURCE, 'open'), result: { sourceId: SOURCE, nodes: [node(SOURCE, 'n1')], edges: [] } };
    state.show({ id: 'i-1', sourceId: SOURCE, record: { title: 'T', caseRef: null, status: 'open', readOnly: true, sourceState, startingEntity: null, version: 1, save: { kind: 'unsaved' } }, resultKeys: [read.key], nodeRefs: [at('n1')], edgeRefs: [] }, [read]);
    const maskSwitch = maskSwitchOf(state, client);
    maskSwitch.turn(true);
    await settle();
    expect(waiting).toEqual([]);
    expect(maskSwitch.status.getState()).toMatchObject({ kind: 'failed', failure: { code: 'ABORTED' } });
  });

  it('sends no further chunk once the source of the investigation was changed after the first', async () => {
    const ids = Array.from({ length: 101 }, (_, at) => `n${at}`);
    const waiting: Waiting[] = [];
    const client = fakeClient({ readRefs: (request, signal) => new Promise((resolve) => void waiting.push({ request, signal, answer: resolve })) });
    const state = createClientState();
    state.bindSource(SOURCE);
    const nodes = ids.map((id) => node(SOURCE, id));
    const read = { key: key(SOURCE, 'open'), result: { sourceId: SOURCE, nodes, edges: [] } };
    const record = { title: 'T', caseRef: null, status: 'open' as const, readOnly: false, sourceState: 'available' as const, startingEntity: null, version: 1, save: { kind: 'unsaved' as const } };
    state.show({ id: 'i-1', sourceId: SOURCE, record, resultKeys: [read.key], nodeRefs: nodes.map((held) => held.ref), edgeRefs: [] }, [read]);
    const maskSwitch = maskSwitchOf(state, client);
    maskSwitch.turn(true);
    await settle();
    state.describeInvestigation({ ...record, readOnly: true, sourceState: 'repointed' });
    waiting[0]?.answer(answered(ids.slice(0, 100).map(masked)));
    await settle();
    expect(waiting).toHaveLength(1);
    expect(maskSwitch.status.getState()).toMatchObject({ kind: 'failed', failure: { code: 'ABORTED' } });
  });

  it.each(['reading', 'failed'])('ends a read that was %s when a view of the same investigation is put in its place, and leaves the switch usable', async (phase) => {
    const waiting: Waiting[] = [];
    const client = fakeClient({ readRefs: (request, signal) => new Promise((resolve) => void waiting.push({ request, signal, answer: resolve })) });
    const state = createClientState();
    state.bindSource(SOURCE);
    const record = { title: 'T', caseRef: null, status: 'open' as const, readOnly: false, sourceState: 'available' as const, startingEntity: null, version: 1, save: { kind: 'unsaved' as const } };
    const read = { key: key(SOURCE, 'open'), result: { sourceId: SOURCE, nodes: [node(SOURCE, 'n1')], edges: [] } };
    const loaded = { id: 'i-1', sourceId: SOURCE, record, resultKeys: [read.key], nodeRefs: [at('n1')], edgeRefs: [] };
    state.show(loaded, [read]);
    const maskSwitch = maskSwitchOf(state, client);
    maskSwitch.turn(true);
    if (phase === 'failed') {
      waiting[0]?.answer(failed);
      await settle();
    }
    const again = { key: { ...key(SOURCE, 'restored'), mask: true }, result: { sourceId: SOURCE, nodes: [masked('n1')], edges: [] } };
    state.replace({ ...loaded, resultKeys: [again.key] }, [again]);
    expect(maskSwitch.status.getState()).toEqual({ kind: 'idle' });
    expect(state.loadedGraph().nodes.map((held) => held.display.title)).toEqual(['Mn1']);
    maskSwitch.turn(false);
    expect(waiting.at(-1)?.request.mask).toBeUndefined();
  });
});
