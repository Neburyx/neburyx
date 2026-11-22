import type { DraftWriteRequest, ReadRefsRequest, ReadRefsResponse } from '@neburyx/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { failure } from '../patterns/patterns-kit.js';
import { AUTOSAVE_DELAY_MS, draftSyncOf, unsavedChangesOf } from '../draft/draft-sync.js';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { edge, edgeRef, key, node, ref } from '../state/test-data.js';
import { maskSwitchOf } from './mask-switch.js';

const ID = '0192f000-0000-7000-8000-0000000000a1';
const SOURCE = 'demo';
const at = (id: string) => ref(SOURCE, 'type-a', id);

function rig() {
  const writes: DraftWriteRequest[] = [];
  const asked: Array<{ readonly request: ReadRefsRequest; readonly answer: (result: ApiResult<ReadRefsResponse>) => void }> = [];
  const client = fakeClient({
    saveDraft: async (_id, version, body) => {
      writes.push(body);
      return { ok: true, value: { version: version + 1, save: { state: 'unsaved', savedAt: null }, notes: body.notes } };
    },
    readRefs: (request) => new Promise((resolve) => void asked.push({ request, answer: resolve })),
  });
  const state = createClientState();
  state.bindSource(SOURCE);
  const nodes = ['A', 'B', 'C'].map((id) => node(SOURCE, id));
  const edges = [edge(SOURCE, 'e1', 'A', 'B'), edge(SOURCE, 'e2', 'B', 'C')];
  const read = { key: key(SOURCE), result: { sourceId: SOURCE, nodes, edges } };
  state.show({ id: ID, sourceId: SOURCE, record: { title: 'T', caseRef: null, status: 'open', readOnly: false, sourceState: 'available', startingEntity: null, version: 1, save: { kind: 'unsaved' } }, resultKeys: [read.key], nodeRefs: nodes.map((held) => held.ref), edgeRefs: edges.map((held) => held.ref) }, [read]);
  const sync = draftSyncOf(state, client);
  sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, writable: true });
  const move = (id: string, x: number): void => state.presentation.setPosition(elementKey(at(id)), { x, y: 0 });
  return { writes, asked, client, state, sync, move, maskSwitch: maskSwitchOf(state, client) };
}

const cleanup = (_rig: unknown): void => void vi.clearAllTimers();
const settle = () => new Promise<void>((done) => void queueMicrotask(done));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the draft while the view is read again after a change of the masking setting', () => {
  it('still counts what was not written as unsaved, still asks to be settled and still warns on leaving, and writes only the draft as it was before', async () => {
    const { writes, state, sync, move } = rig();
    move('A', 7);
    state.setMask(true);
    expect(sync.needsSettle()).toBe(true);
    expect(unsavedChangesOf(state).getState()).toBe(true);
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.queryContext.loaded.edges).toHaveLength(2);
    expect(writes[0]?.layout.nodes.find((entry) => entry.id === 'A')).toMatchObject({ x: 7 });
  });

  it('writes, after the read, the draft it held before with only the next change added, keeping the items the read did not give back', async () => {
    const { writes, asked, client, state, move } = rig();
    move('A', 1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    const before = writes.at(-1);
    expect(before?.layout.nodes).toHaveLength(3);
    maskSwitchOf(state, client).turn(true);
    await settle();
    asked[0]?.answer({ ok: true, value: { nodes: [node(SOURCE, 'A'), node(SOURCE, 'B')], edges: [], missing: { entities: [at('C')], edges: [] } } });
    await vi.advanceTimersByTimeAsync(0);
    asked[1]?.answer({ ok: true, value: { nodes: [], edges: [edge(SOURCE, 'e1', 'A', 'B')], missing: { entities: [], edges: [edgeRef(SOURCE, 'e2')] } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.rereading.getState()).toBe(false);
    move('A', 2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    const next = writes.at(-1);
    const identity = (entry: { readonly t: string; readonly id: string }) => `${entry.t}:${entry.id}`;
    expect(next?.layout.nodes.map(identity).sort()).toEqual(before?.layout.nodes.map(identity).sort());
    expect(next?.layout.nodes.find((entry) => entry.id === 'C')).toEqual(before?.layout.nodes.find((entry) => entry.id === 'C'));
    expect(next?.queryContext.loaded.edges).toEqual(before?.queryContext.loaded.edges);
    expect(next?.layout.nodes.find((entry) => entry.id === 'A')).toMatchObject({ x: 2 });
  });

  const record = { title: 'T', caseRef: null, status: 'open' as const, readOnly: false, sourceState: 'available' as const, startingEntity: null, version: 1, save: { kind: 'unsaved' as const } };
  const showOther = (state: ReturnType<typeof rig>['state']): void => {
    const other = { key: { ...key(SOURCE, 'other'), mask: state.mask.getState() }, result: { sourceId: SOURCE, nodes: [node(SOURCE, 'Z')], edges: [] } };
    state.show({ id: '0192f000-0000-7000-8000-0000000000b2', sourceId: SOURCE, record, resultKeys: [other.key], nodeRefs: [at('Z')], edgeRefs: [] }, [other]);
  };

  it.each(['pending', 'failed'])('writes nothing for a clean draft, and the draft as it was before for a changed one, when another investigation is shown during a read that is %s', async (phase) => {
    const clean = rig();
    clean.maskSwitch.turn(true);
    if (phase === 'failed') {
      clean.asked[0]?.answer({ ok: false, failure: failure('RATE_LIMITED') });
      await vi.advanceTimersByTimeAsync(0);
    }
    showOther(clean.state);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(clean.writes).toEqual([]);
    cleanup(clean);

    const changed = rig();
    changed.move('A', 9);
    changed.maskSwitch.turn(true);
    if (phase === 'failed') {
      changed.asked[0]?.answer({ ok: false, failure: failure('RATE_LIMITED') });
      await vi.advanceTimersByTimeAsync(0);
    }
    showOther(changed.state);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(changed.writes).toHaveLength(1);
    expect(changed.writes[0]?.queryContext.loaded.edges).toHaveLength(2);
    expect(changed.writes[0]?.layout.nodes.find((entry) => entry.id === 'A')).toMatchObject({ x: 9 });
  });

  it('keeps one entry for an item that went missing, came back, was moved and went missing again, the latest', async () => {
    const { writes, asked, client, state, move } = rig();
    const answerMissingC = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(0);
      asked.at(-2)?.answer({ ok: true, value: { nodes: [node(SOURCE, 'A'), node(SOURCE, 'B')], edges: [], missing: { entities: [at('C')], edges: [] } } });
      await vi.advanceTimersByTimeAsync(0);
      asked.at(-1)?.answer({ ok: true, value: { nodes: [], edges: [edge(SOURCE, 'e1', 'A', 'B')], missing: { entities: [], edges: [edgeRef(SOURCE, 'e2')] } } });
      await vi.advanceTimersByTimeAsync(0);
    };
    const maskSwitch = maskSwitchOf(state, client);
    maskSwitch.turn(true);
    await vi.advanceTimersByTimeAsync(0);
    asked[0]?.answer({ ok: true, value: { nodes: [node(SOURCE, 'A'), node(SOURCE, 'B')], edges: [], missing: { entities: [at('C')], edges: [] } } });
    await vi.advanceTimersByTimeAsync(0);
    asked[1]?.answer({ ok: true, value: { nodes: [], edges: [edge(SOURCE, 'e1', 'A', 'B')], missing: { entities: [], edges: [edgeRef(SOURCE, 'e2')] } } });
    await vi.advanceTimersByTimeAsync(0);
    maskSwitch.turn(false);
    await vi.advanceTimersByTimeAsync(0);
    asked[2]?.answer({ ok: true, value: { nodes: ['A', 'B', 'C'].map((id) => node(SOURCE, id)), edges: [], missing: { entities: [], edges: [] } } });
    await vi.advanceTimersByTimeAsync(0);
    asked[3]?.answer({ ok: true, value: { nodes: [], edges: [edge(SOURCE, 'e1', 'A', 'B'), edge(SOURCE, 'e2', 'B', 'C')], missing: { entities: [], edges: [] } } });
    await vi.advanceTimersByTimeAsync(0);
    move('C', 42);
    maskSwitch.turn(true);
    await answerMissingC();
    move('A', 1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    const entries = writes.at(-1)?.layout.nodes.filter((entry) => entry.id === 'C') ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ x: 42 });
  });
});
