import type { DraftWriteRequest, DraftWriteResponse } from '@neburyx/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiFailure, ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { key, ref, result } from '../state/test-data.js';
import { AUTOSAVE_DELAY_MS, createDraftSync, KEEPALIVE_LIMIT_BYTES, RETRY_STEADY_MS, STALLED_AFTER_MS, type DraftSync } from './draft-sync.js';

const ID = '0192f000-0000-7000-8000-0000000000a1';
const OK = (version: number, notes: string | null = null): ApiResult<DraftWriteResponse> => ({ ok: true, value: { version, save: { state: 'unsaved', savedAt: null }, notes } });
const fail = (failure: ApiFailure): ApiResult<DraftWriteResponse> => ({ ok: false, failure });
const SERVER_DOWN = fail({ code: 'INTERNAL_ERROR', message: 'x', retryable: true, traceId: 't' });
const CONFLICT = fail({ code: 'CONFLICTED_VIEW_VERSION', message: 'x', retryable: false, traceId: 't' });
const REFUSED = fail({ code: 'INVALID_REQUEST', message: 'x', retryable: false, traceId: 't' });

interface Write {
  readonly version: number;
  readonly body: DraftWriteRequest;
  readonly keepalive: boolean | undefined;
}

class FakePage {
  readonly handlers = new Map<string, Set<(event: Event) => void>>();
  visibilityState = 'visible';
  addEventListener(type: string, listener: (event: Event) => void): void {
    this.handlers.set(type, (this.handlers.get(type) ?? new Set()).add(listener));
  }
  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.handlers.get(type)?.delete(listener);
  }
  fire(type: string, event: Event = new Event(type, { cancelable: true })): Event {
    for (const listener of [...(this.handlers.get(type) ?? [])]) listener(event);
    return event;
  }
}

function rig(answers: (call: number) => ApiResult<DraftWriteResponse> = (call) => OK(call + 1), opened = true) {
  const writes: Write[] = [];
  const page = new FakePage();
  const state: ClientState = createClientState();
  state.bindSource('demo');
  const read = result('demo', ['A']);
  state.show({ id: ID, sourceId: 'demo', record: { title: 'T', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [key('demo')], nodeRefs: read.nodes.map((n) => n.ref), edgeRefs: [] }, [{ key: key('demo'), result: read }]);
  const client = fakeClient({
    saveDraft: async (_id, version, body, options) => {
      writes.push({ version, body, keepalive: options?.keepalive });
      return answers(writes.length);
    },
  });
  const sync: DraftSync = createDraftSync({ client, state, page, document: page });
  if (opened) sync.adopt(ID, { version: 1, notes: null, writable: true });
  const move = (x = 1): void => state.presentation.setPosition(elementKey(ref('demo', 'type-a', 'A')), { x, y: 0 });
  return { writes, page, state, sync, move };
}

beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-11-10T10:00:00.000Z') }));
afterEach(() => vi.useRealTimers());

describe('autosave', () => {
  it('writes once, with the current version, when the delay has passed without another change, and a burst of changes is one write', async () => {
    const { writes, move } = rig();
    move(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
    expect(writes).toHaveLength(0);
    move(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
    move(3);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.version).toBe(1);
    expect(writes[0]?.body.layout.nodes[0]).toMatchObject({ x: 3, y: 0 });
  });

  it('sends the version of the last answer in the next write', async () => {
    const { writes, move } = rig((call) => OK(call + 10));
    move(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    move(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes.map((write) => write.version)).toEqual([1, 11]);
  });

  it('sends nothing when nothing in the draft changed, and a selection or panel is not a change', async () => {
    const { writes, state } = rig();
    state.presentation.select([elementKey(ref('demo', 'type-a', 'A'))]);
    state.presentation.setLegendOpen(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(writes).toHaveLength(0);
  });

  it('sends nothing before the draft is adopted, and nothing for one that is not writable', async () => {
    const before = rig(undefined, false);
    before.move();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(before.writes).toHaveLength(0);
    before.sync.adopt(ID, { version: 1, notes: null, writable: false });
    before.move(9);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(before.writes).toHaveLength(0);
  });

  it('sets the save pill from the answer', async () => {
    const { state, move } = rig(() => ({ ok: true, value: { version: 2, save: { state: 'saved', savedAt: '2026-11-10T09:42:00.000Z' }, notes: null } }));
    move();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(state.investigation.getState().record?.save).toEqual({ kind: 'saved', at: '2026-11-10T09:42:00.000Z' });
  });

  it('writes back the note it last received', async () => {
    const { writes, move, sync } = rig();
    sync.adopt(ID, { version: 1, notes: 'seen before', writable: true });
    move();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes[0]?.body.notes).toBe('seen before');
  });
});

describe('a write that fails', () => {
  it('keeps the changes, says it is trying again, retries after 3, 6 and 12 s and then every 30 s, and goes quiet when a retry works', async () => {
    const { writes, move, sync } = rig((call) => (call <= 5 ? SERVER_DOWN : OK(6)));
    move();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(sync.status.getState()).toEqual({ kind: 'failing', stalled: false });
    await vi.advanceTimersByTimeAsync(3000);
    expect(writes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(6000);
    expect(writes).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(12000);
    expect(writes).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(RETRY_STEADY_MS - 1);
    expect(writes).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(RETRY_STEADY_MS);
    expect(writes).toHaveLength(6);
    expect(sync.status.getState()).toEqual({ kind: 'idle' });
  });

  it('retries a network error and a 429 after the longer of its step and the wait the server gave', async () => {
    const wait = fail({ code: 'RATE_LIMITED', message: 'x', retryable: true, traceId: 't', details: { retryAfterMs: 20000 } });
    const { writes, move } = rig((call) => (call === 1 ? wait : call === 2 ? fail({ code: 'NETWORK_UNAVAILABLE' }) : OK(3)));
    move();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    await vi.advanceTimersByTimeAsync(19999);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(6000);
    expect(writes).toHaveLength(3);
  });

  it('says the changes are still not saved after two minutes of failures, and goes on trying', async () => {
    const { writes, move, sync } = rig(() => SERVER_DOWN);
    move();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    await vi.advanceTimersByTimeAsync(STALLED_AFTER_MS);
    expect(sync.status.getState()).toEqual({ kind: 'failing', stalled: true });
    const before = writes.length;
    await vi.advanceTimersByTimeAsync(RETRY_STEADY_MS);
    expect(writes.length).toBeGreaterThan(before);
  });

  it('stops retrying on a refusal, says so plainly, and writes again when the person asks', async () => {
    const { writes, move, sync } = rig((call) => (call === 1 ? REFUSED : OK(2)));
    move();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(sync.status.getState()).toEqual({ kind: 'rejected' });
    await vi.advanceTimersByTimeAsync(RETRY_STEADY_MS * 3);
    expect(writes).toHaveLength(1);
    sync.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(2);
    expect(sync.status.getState()).toEqual({ kind: 'idle' });
  });

  it('goes to the conflict state on CONFLICTED_VIEW_VERSION, writes nothing more and leaves the canvas as it is', async () => {
    const { writes, move, sync, state } = rig(() => CONFLICT);
    move(7);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(sync.status.getState()).toEqual({ kind: 'conflict' });
    move(8);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 5);
    expect(writes).toHaveLength(1);
    expect(state.presentation.view.getState().positions.get(elementKey(ref('demo', 'type-a', 'A')))).toEqual({ x: 8, y: 0 });
  });

  it('only changes its status when the state changes, never on a retry', async () => {
    const { move, sync } = rig(() => SERVER_DOWN);
    const seen: string[] = [];
    sync.status.subscribe(() => seen.push(JSON.stringify(sync.status.getState())));
    move();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 3000 + 6000 + 12000 + RETRY_STEADY_MS);
    expect(seen).toEqual([JSON.stringify({ kind: 'failing', stalled: false })]);
  });
});

describe('leaving the page', () => {
  it('writes at once when the page is hidden', async () => {
    const { writes, move, page } = rig();
    move();
    page.visibilityState = 'hidden';
    page.fire('visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
  });

  it('asks before the page is left while a change is waiting or not saved, and not otherwise', async () => {
    const { move, page } = rig();
    expect(page.fire('beforeunload').defaultPrevented).toBe(false);
    move();
    expect(page.fire('beforeunload').defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(page.fire('beforeunload').defaultPrevented).toBe(false);
  });

  it('sends the waiting draft with keepalive when the page is left and the body is within the size the browser allows, and does not when it is larger', async () => {
    const small = rig();
    small.move();
    small.page.fire('pagehide');
    await vi.advanceTimersByTimeAsync(0);
    expect(small.writes).toHaveLength(1);
    expect(small.writes[0]?.keepalive).toBe(true);
    const large = rig();
    large.sync.adopt(ID, { version: 1, notes: 'n'.repeat(KEEPALIVE_LIMIT_BYTES + 1), writable: true });
    large.move();
    large.page.fire('pagehide');
    await vi.advanceTimersByTimeAsync(0);
    expect(large.writes).toHaveLength(0);
  });
});

describe('another investigation taking the place of the one shown', () => {
  it('writes the draft that was waiting once, for the investigation it belongs to', async () => {
    const { writes, move, state } = rig();
    move(5);
    const other = '0192f000-0000-7000-8000-0000000000b1';
    const read = result('demo', ['B']);
    state.show({ id: other, sourceId: 'demo', record: { title: 'U', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [key('demo', 'other')], nodeRefs: read.nodes.map((n) => n.ref), edgeRefs: [] }, [{ key: key('demo', 'other'), result: read }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body.layout.nodes[0]).toMatchObject({ id: 'A', x: 5 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(writes).toHaveLength(1);
  });
});

describe('the filters of a stored draft', () => {
  it('are written as they were while the mapping of the source is not known, and put on the view once it is', async () => {
    const { writes, move, sync, state } = rig(undefined, false);
    const filters = { entityTypes: ['type-a'], relTypes: [], time: null, properties: [] };
    sync.adopt(ID, { version: 1, notes: null, filters, writable: true });
    move(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes[0]?.body.queryContext.filters).toEqual(filters);
    state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b'], relationshipTypes: [] });
    expect(state.presentation.view.getState().typeFilter.offEntityTypes.has('type-b')).toBe(true);
  });
});

describe('a draft too large to send as the page is left', () => {
  it('is measured in bytes, so text of two-byte characters is not taken for half its size', async () => {
    const wide = rig();
    wide.sync.adopt(ID, { version: 1, notes: 'é'.repeat(KEEPALIVE_LIMIT_BYTES / 2), writable: true });
    wide.move();
    wide.page.fire('pagehide');
    await vi.advanceTimersByTimeAsync(0);
    expect(wide.writes).toHaveLength(0);
  });
});

describe('two tabs of one person', () => {
  it('lets the first write win and sends the second to the conflict state, with the first tab\'s draft kept', async () => {
    let stored = 1;
    const answer = (_id: string, version: number): ApiResult<DraftWriteResponse> => {
      if (version !== stored) return CONFLICT;
      stored += 1;
      return OK(stored);
    };
    const make = () => {
      const state: ClientState = createClientState();
      state.bindSource('demo');
      const read = result('demo', ['A']);
      state.show({ id: ID, sourceId: 'demo', record: { title: 'T', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [key('demo')], nodeRefs: read.nodes.map((n) => n.ref), edgeRefs: [] }, [{ key: key('demo'), result: read }]);
      const sync = createDraftSync({ client: fakeClient({ saveDraft: async (id, version) => answer(id, version) }), state, page: new FakePage(), document: new FakePage() });
      sync.adopt(ID, { version: 1, notes: null, writable: true });
      return { state, sync };
    };
    const first = make();
    const second = make();
    first.state.presentation.setPosition(elementKey(ref('demo', 'type-a', 'A')), { x: 1, y: 1 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    second.state.presentation.setPosition(elementKey(ref('demo', 'type-a', 'A')), { x: 2, y: 2 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(first.sync.status.getState()).toEqual({ kind: 'idle' });
    expect(second.sync.status.getState()).toEqual({ kind: 'conflict' });
    expect(stored).toBe(2);
  });
});

describe('another investigation taking the place of one whose writes were failing or in flight', () => {
  const other = '0192f000-0000-7000-8000-0000000000b1';
  const showOther = (state: ClientState): void => {
    const read = result('demo', ['B']);
    state.show({ id: other, sourceId: 'demo', record: { title: 'U', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [key('demo', 'other')], nodeRefs: read.nodes.map((n) => n.ref), edgeRefs: [] }, [{ key: key('demo', 'other'), result: read }]);
  };

  it('writes the new investigation after its delay, though the old one was failing, and clears the status', async () => {
    const { writes, move, state, sync } = rig((call) => (call <= 1 ? SERVER_DOWN : OK(call + 1)));
    move(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(sync.status.getState().kind).toBe('failing');
    showOther(state);
    sync.adopt(other, { version: 1, notes: null, writable: true });
    expect(sync.status.getState()).toEqual({ kind: 'idle' });
    state.presentation.setPosition(elementKey(ref('demo', 'type-a', 'B')), { x: 4, y: 4 });
    const before = writes.length;
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes.length).toBeGreaterThan(before);
    expect(writes.at(-1)?.body.layout.nodes[0]).toMatchObject({ id: 'B', x: 4 });
  });

  it('remembers a conflict on the old draft, and goes to the conflict state when it is shown again', async () => {
    const { writes, move, state, sync } = rig((call) => (call === 1 ? CONFLICT : OK(call)));
    move(2);
    showOther(state);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    state.show({ id: ID, sourceId: 'demo', record: { title: 'T', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [key('demo')], nodeRefs: [ref('demo', 'type-a', 'A')], edgeRefs: [] }, []);
    move(3);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(writes).toHaveLength(1);
  });

  it('sends what the old investigation changed during its own write once that write is over', async () => {
    const writes: Write[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state: ClientState = createClientState();
    state.bindSource('demo');
    const read = result('demo', ['A']);
    state.show({ id: ID, sourceId: 'demo', record: { title: 'T', caseRef: null, save: { kind: 'unsaved' } }, resultKeys: [key('demo')], nodeRefs: read.nodes.map((n) => n.ref), edgeRefs: [] }, [{ key: key('demo'), result: read }]);
    const client = fakeClient({
      saveDraft: async (_id, version, body) => {
        writes.push({ version, body, keepalive: undefined });
        if (writes.length === 1) await held;
        return OK(version + 1);
      },
    });
    const page = new FakePage();
    const sync = createDraftSync({ client, state, page, document: page });
    sync.adopt(ID, { version: 1, notes: null, writable: true });
    state.presentation.setPosition(elementKey(ref('demo', 'type-a', 'A')), { x: 1, y: 0 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes).toHaveLength(1);
    state.presentation.setPosition(elementKey(ref('demo', 'type-a', 'A')), { x: 2, y: 0 });
    showOther(state);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.version).toBe(2);
    expect(writes[1]?.body.layout.nodes[0]).toMatchObject({ id: 'A', x: 2 });
  });
});

