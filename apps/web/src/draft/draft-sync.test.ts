import type { DraftWriteRequest, DraftWriteResponse } from '@neburyx/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiFailure, ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { key, ref, result } from '../state/test-data.js';
import { AUTOSAVE_DELAY_MS, createDraftSync, KEEPALIVE_LIMIT_BYTES, RETRY_STEADY_MS, STALLED_AFTER_MS, type DraftSync } from './draft-sync.js';
import { carriedOf } from './draft-document.js';

const ID = '0192f000-0000-7000-8000-0000000000a1';
const OK = (version: number, notes: string | null = null): ApiResult<DraftWriteResponse> => ({ ok: true, value: { version, save: { state: 'unsaved', savedAt: null }, notes } });
const fail = (failure: ApiFailure): ApiResult<DraftWriteResponse> => ({ ok: false, failure });
const SERVER_DOWN = fail({ code: 'INTERNAL_ERROR', message: 'x', retryable: true, traceId: 't' });
const CONFLICT = fail({ code: 'CONFLICTED_VIEW_VERSION', message: 'x', retryable: false, traceId: 't' });
const REFUSED = fail({ code: 'INVALID_REQUEST', message: 'x', retryable: false, traceId: 't' });
const GONE = fail({ code: 'NOT_FOUND', message: 'x', retryable: false, traceId: 't' });

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
  state.show({ id: ID, sourceId: 'demo', record: { title: 'T', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [key('demo')], nodeRefs: read.nodes.map((n) => n.ref), edgeRefs: [] }, [{ key: key('demo'), result: read }]);
  const client = fakeClient({
    saveDraft: async (_id, version, body, options) => {
      writes.push({ version, body, keepalive: options?.keepalive });
      return answers(writes.length);
    },
  });
  const sync: DraftSync = createDraftSync({ client, state, page, document: page });
  if (opened) sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, writable: true });
  const move = (x = 1): void => state.presentation.setPosition(elementKey(ref('demo', 'type-a', 'A')), { x, y: 0 });
  return { writes, page, state, sync, move };
}

beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-11-10T10:00:00.000Z') }));
afterEach(() => vi.useRealTimers());

describe('the first viewport of a draft that held none', () => {
  it('is the drawing\'s own: it is not written, and nothing waits to be written for it', async () => {
    const { writes, state, sync } = rig();
    state.presentation.setViewport({ zoom: 1, x: 612, y: 318 });
    expect(sync.needsSettle()).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(writes).toHaveLength(0);
  });

  it('is the same when the viewport comes before the draft is adopted', async () => {
    const { writes, state, sync } = rig(undefined, false);
    state.presentation.setViewport({ zoom: 1, x: 612, y: 318 });
    sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, writable: true });
    expect(sync.needsSettle()).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(writes).toHaveLength(0);
  });

  it('is written with the next change, and a later move of the viewport is written alone', async () => {
    const { writes, state, move } = rig();
    state.presentation.setViewport({ zoom: 1, x: 612, y: 318 });
    move(4);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body.layout.viewport).toEqual({ zoom: 1, x: 612, y: 318 });
    state.presentation.setViewport({ zoom: 2, x: 600, y: 300 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.body.layout.viewport).toEqual({ zoom: 2, x: 600, y: 300 });
  });

  it('does not hide a move of the viewport made after the draft was adopted with one, nor a change that comes first', async () => {
    const stored = rig(undefined, false);
    stored.state.presentation.setViewport({ zoom: 1, x: 10, y: 10 });
    stored.sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, writable: true });
    stored.state.presentation.setViewport({ zoom: 3, x: 0, y: 0 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(stored.writes).toHaveLength(1);
    const moved = rig();
    moved.move(5);
    moved.state.presentation.setViewport({ zoom: 1, x: 612, y: 318 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(moved.writes).toHaveLength(1);
    expect(moved.writes[0]?.body.layout.viewport).toEqual({ zoom: 1, x: 612, y: 318 });
  });
});

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
    before.sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, writable: false });
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
    sync.adopt(ID, { version: 1, notes: 'seen before', basedOnViewId: null, writable: true });
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
    large.sync.adopt(ID, { version: 1, notes: 'n'.repeat(KEEPALIVE_LIMIT_BYTES + 1), basedOnViewId: null, writable: true });
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
    state.show({ id: other, sourceId: 'demo', record: { title: 'U', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [key('demo', 'other')], nodeRefs: read.nodes.map((n) => n.ref), edgeRefs: [] }, [{ key: key('demo', 'other'), result: read }]);
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
    sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, filters, writable: true });
    move(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes[0]?.body.queryContext.filters).toEqual(filters);
    state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b'], relationshipTypes: [] });
    expect(state.presentation.view.getState().typeFilter.offEntityTypes.has('type-b')).toBe(true);
  });
});

describe('the parts of a stored draft the web does not edit', () => {
  const stored = {
    layout: { schemaVersion: 1 as const, layout: 'force', nodes: [{ t: 'type-a', id: 'A', pinned: false, hidden: false, groupId: 'g1' }], edges: [], groups: [{ id: 'g1', label: 'One', by: 'manual', members: [{ t: 'type-a', id: 'A' }] }] },
    queryContext: { schemaVersion: 1 as const, loaded: { nodes: [], edges: [] }, expansions: [{ from: { t: 'type-a', id: 'A' }, relTypes: ['rel-a'], neighborTypes: [], window: null, sort: 'default', pages: 2 }], filters: { entityTypes: [], relTypes: [], time: { from: '2024-01-01' }, properties: [{ key: 'prop-x', op: 'gte', values: ['10'] }] } },
  };
  const carried = { ...carriedOf(stored, 'force', true), time: stored.queryContext.filters.time, properties: stored.queryContext.filters.properties, expansions: stored.queryContext.expansions };
  const filters = { entityTypes: ['type-a'], relTypes: [], time: carried.time, properties: carried.properties };

  it('are still in the first write after the mapping is known, and in the ones that follow a change of a type filter', async () => {
    const { writes, move, sync, state } = rig(undefined, false);
    sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, filters, carried, writable: true });
    state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b'], relationshipTypes: [] });
    move(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes[0]?.body.queryContext.filters.properties).toEqual(carried.properties);
    expect(writes[0]?.body.queryContext.filters.time).toEqual(carried.time);
    expect(writes[0]?.body.queryContext.expansions).toEqual(carried.expansions);
    state.setEntityTypeOff('type-b', false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    const last = writes[writes.length - 1]?.body.queryContext;
    expect(last?.filters.properties).toEqual(carried.properties);
    expect(last?.expansions).toEqual(carried.expansions);
    expect(writes[0]?.body.layout.groups).toEqual(stored.layout.groups);
  });
});

describe('a layout name of a stored draft that the web does not offer', () => {
  it('is written back until the person picks another layout, and not again when they pick the one shown at the open', async () => {
    const { writes, move, sync, state } = rig(undefined, false);
    const stored = { layout: { schemaVersion: 1 as const, layout: 'an-unoffered-layout', nodes: [], edges: [], groups: [] }, queryContext: { schemaVersion: 1 as const, loaded: { nodes: [], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } } };
    sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, carried: carriedOf(stored, state.presentation.view.getState().layout, false), writable: true });
    move(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes.at(-1)?.body.layout.layout).toBe('an-unoffered-layout');
    state.presentation.setLayout('radial');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes.at(-1)?.body.layout.layout).toBe('radial');
    state.presentation.setLayout('force');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes.at(-1)?.body.layout.layout).toBe('force');
  });
});

describe('the type filters of a stored draft that name a type the mapping no longer has', () => {
  it('are written back with the types left on, so the type has its saved state when the mapping has it again', async () => {
    const { writes, move, sync, state } = rig(undefined, false);
    sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, filters: { entityTypes: ['type-a', 'type-gone'], relTypes: ['rel-gone'], time: null, properties: [] }, writable: true });
    state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b'], relationshipTypes: ['rel-a'] });
    expect(state.presentation.view.getState().typeFilter.offEntityTypes.has('type-b')).toBe(true);
    move(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes.at(-1)?.body.queryContext.filters.entityTypes).toEqual(['type-a', 'type-gone']);
    expect(writes.at(-1)?.body.queryContext.filters.relTypes).toEqual(['rel-gone']);
  });

  it('keep the saved list as a list when the type that was off is the one the mapping dropped, and stop keeping it once the person changes a type filter', async () => {
    const { writes, move, sync, state } = rig(undefined, false);
    sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, filters: { entityTypes: ['type-a', 'type-b'], relTypes: ['rel-a'], time: null, properties: [] }, writable: true });
    state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b'], relationshipTypes: ['rel-a'] });
    expect(state.presentation.view.getState().typeFilter.offEntityTypes.size).toBe(0);
    move(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes.at(-1)?.body.queryContext.filters).toMatchObject({ entityTypes: ['type-a', 'type-b'], relTypes: ['rel-a'] });
    state.setEntityTypeOff('type-b', true);
    move(4);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes.at(-1)?.body.queryContext.filters.entityTypes).toEqual(['type-a']);
    state.setEntityTypeOff('type-b', false);
    move(5);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes.at(-1)?.body.queryContext.filters.entityTypes).toEqual([]);
  });

  it('bring an entity type that was off back off when the mapping has it again', async () => {
    const { writes, move, sync, state } = rig(undefined, false);
    sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, filters: { entityTypes: ['type-a', 'type-b'], relTypes: [], time: null, properties: [] }, writable: true });
    state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b'], relationshipTypes: [] });
    move(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    const written = writes.at(-1)?.body.queryContext.filters;
    const again = rig(undefined, false);
    again.sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, filters: written, writable: true });
    again.state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b', 'type-gone'], relationshipTypes: [] });
    expect(again.state.presentation.view.getState().typeFilter.offEntityTypes.has('type-gone')).toBe(true);
  });

  it('bring a relationship type that was off back off when the mapping has it again', async () => {
    const { writes, move, sync, state } = rig(undefined, false);
    sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, filters: { entityTypes: [], relTypes: ['rel-a'], time: null, properties: [] }, writable: true });
    state.presentation.setMappedTypes({ entityTypes: ['type-a'], relationshipTypes: ['rel-a'] });
    move(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes.at(-1)?.body.queryContext.filters.relTypes).toEqual(['rel-a']);
    const again = rig(undefined, false);
    again.sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, filters: writes.at(-1)?.body.queryContext.filters, writable: true });
    again.state.presentation.setMappedTypes({ entityTypes: ['type-a'], relationshipTypes: ['rel-a', 'rel-gone'] });
    expect(again.state.presentation.view.getState().typeFilter.offRelationshipTypes.has('rel-gone')).toBe(true);
  });

  it('write a stored list as it was when every type in it is mapped', async () => {
    const { writes, move, sync, state } = rig(undefined, false);
    sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, filters: { entityTypes: ['type-a', 'type-gone'], relTypes: [], time: null, properties: [] }, writable: true });
    state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-gone'], relationshipTypes: [] });
    move(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes.at(-1)?.body.queryContext.filters.entityTypes).toEqual(['type-a', 'type-gone']);
  });
});

describe('a draft too large to send as the page is left', () => {
  it('is measured in bytes, so text of two-byte characters is not taken for half its size', async () => {
    const wide = rig();
    wide.sync.adopt(ID, { version: 1, notes: 'é'.repeat(KEEPALIVE_LIMIT_BYTES / 2), basedOnViewId: null, writable: true });
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
      state.show({ id: ID, sourceId: 'demo', record: { title: 'T', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [key('demo')], nodeRefs: read.nodes.map((n) => n.ref), edgeRefs: [] }, [{ key: key('demo'), result: read }]);
      const sync = createDraftSync({ client: fakeClient({ saveDraft: async (id, version) => answer(id, version) }), state, page: new FakePage(), document: new FakePage() });
      sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, writable: true });
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
    state.show({ id: other, sourceId: 'demo', record: { title: 'U', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [key('demo', 'other')], nodeRefs: read.nodes.map((n) => n.ref), edgeRefs: [] }, [{ key: key('demo', 'other'), result: read }]);
  };

  it('writes the new investigation after its delay, though the old one was failing, and clears the status', async () => {
    const { writes, move, state, sync } = rig((call) => (call <= 1 ? SERVER_DOWN : OK(call + 1)));
    move(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(sync.status.getState().kind).toBe('failing');
    showOther(state);
    sync.adopt(other, { version: 1, notes: null, basedOnViewId: null, writable: true });
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
    state.show({ id: ID, sourceId: 'demo', record: { title: 'T', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [key('demo')], nodeRefs: [ref('demo', 'type-a', 'A')], edgeRefs: [] }, []);
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
    state.show({ id: ID, sourceId: 'demo', record: { title: 'T', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [key('demo')], nodeRefs: read.nodes.map((n) => n.ref), edgeRefs: [] }, [{ key: key('demo'), result: read }]);
    const client = fakeClient({
      saveDraft: async (_id, version, body) => {
        writes.push({ version, body, keepalive: undefined });
        if (writes.length === 1) await held;
        return OK(version + 1);
      },
    });
    const page = new FakePage();
    const sync = createDraftSync({ client, state, page, document: page });
    sync.adopt(ID, { version: 1, notes: null, basedOnViewId: null, writable: true });
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


describe('settling the draft before another investigation is opened', () => {
  it('answers at once, writing nothing, when nothing is waiting', async () => {
    const { writes, sync } = rig();
    expect(sync.needsSettle()).toBe(false);
    await expect(sync.settle()).resolves.toBe(true);
    expect(writes).toHaveLength(0);
    expect(sync.leaving.getState()).toBe(false);
  });

  it('writes what is waiting without the delay, and answers when it is saved', async () => {
    const { writes, sync, move } = rig();
    move(5);
    expect(sync.needsSettle()).toBe(true);
    await expect(sync.settle()).resolves.toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body.layout.nodes[0]).toMatchObject({ x: 5 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(writes, 'the waiting timer was cancelled, nothing is written twice').toHaveLength(1);
  });

  it('waits for a write that is already going on, then writes what changed meanwhile', async () => {
    let release: (() => void) | undefined;
    const { writes, sync, move, state } = rig();
    const slow = fakeClient({
      saveDraft: async (_id, version, body) => {
        writes.push({ version, body, keepalive: undefined });
        if (writes.length === 1) await new Promise<void>((resolve) => (release = resolve));
        return OK(writes.length + 1);
      },
    });
    sync.dispose();
    const second = createDraftSync({ client: slow, state, page: new FakePage(), document: new FakePage() });
    second.adopt(ID, { version: 1, notes: null, basedOnViewId: null, writable: true });
    move(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes).toHaveLength(1);
    move(2);
    const settled = second.settle();
    release?.();
    await expect(settled).resolves.toBe(true);
    expect(writes.map((write) => write.body.layout.nodes[0]?.x)).toEqual([1, 2]);
  });

  it('holds the person when the write fails, and goes on once a retry of theirs saves it', async () => {
    let up = false;
    const { writes, sync, move } = rig(() => (up ? OK(2) : SERVER_DOWN));
    move();
    let answer: boolean | undefined;
    void sync.settle().then((leave) => (answer = leave));
    await vi.advanceTimersByTimeAsync(0);
    expect(answer, 'held').toBeUndefined();
    expect(sync.leaving.getState()).toBe(true);
    expect(sync.status.getState()).toEqual({ kind: 'failing', stalled: false });
    up = true;
    sync.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toBe(true);
    expect(sync.leaving.getState()).toBe(false);
    expect(writes.length).toBeGreaterThanOrEqual(2);
  });

  it('holds the person when the server refuses the write, since that is lost work too', async () => {
    const { sync, move } = rig(() => REFUSED);
    move();
    let answer: boolean | undefined;
    void sync.settle().then((leave) => (answer = leave));
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toBeUndefined();
    expect(sync.leaving.getState()).toBe(true);
    expect(sync.status.getState().kind).toBe('rejected');
  });

  it('goes on when the person chooses to leave, and the changes of the investigation left are tried once more where it is shown no more', async () => {
    const { sync, move } = rig(() => SERVER_DOWN);
    move();
    let answer: boolean | undefined;
    void sync.settle().then((leave) => (answer = leave));
    await vi.advanceTimersByTimeAsync(0);
    sync.leaveAnyway();
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toBe(true);
    expect(sync.leaving.getState()).toBe(false);
  });

  it('does not hold the person for a conflict: that has its own state, and the changes cannot be saved', async () => {
    const { sync, move } = rig(() => CONFLICT);
    move();
    await expect(sync.settle()).resolves.toBe(true);
    expect(sync.status.getState()).toEqual({ kind: 'conflict' });
    expect(sync.leaving.getState()).toBe(false);
  });

  it('lets go when the open is cancelled while it waits', async () => {
    const { sync, move } = rig(() => SERVER_DOWN);
    move();
    const controller = new AbortController();
    const settled = sync.settle(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.leaving.getState()).toBe(true);
    controller.abort();
    await expect(settled).resolves.toBe(false);
    expect(sync.leaving.getState()).toBe(false);
  });

  it('answers false at once for an open that was cancelled before it asked, and a second open takes the place of the first', async () => {
    const { sync, move } = rig(() => SERVER_DOWN);
    move();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(sync.settle(cancelled.signal)).resolves.toBe(false);
    expect(sync.leaving.getState()).toBe(false);
    const first = sync.settle();
    await vi.advanceTimersByTimeAsync(0);
    const second = sync.settle();
    await expect(first).resolves.toBe(false);
    sync.leaveAnyway();
    await expect(second).resolves.toBe(true);
  });

  it('lets the person go on when a conflict is found while they are held', async () => {
    let call = 0;
    const { sync, move } = rig(() => (++call === 1 ? SERVER_DOWN : CONFLICT));
    move();
    let answer: boolean | undefined;
    void sync.settle().then((leave) => (answer = leave));
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.leaving.getState()).toBe(true);
    sync.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toBe(true);
    expect(sync.leaving.getState()).toBe(false);
    expect(sync.status.getState()).toEqual({ kind: 'conflict' });
  });

  it('does not hold the person when the writes succeed but more changes keep coming', async () => {
    const { sync, move, state } = rig();
    let x = 10;
    const busy = fakeClient({
      saveDraft: async () => {
        move(x++);
        return OK(x);
      },
    });
    sync.dispose();
    const second = createDraftSync({ client: busy, state, page: new FakePage(), document: new FakePage() });
    second.adopt(ID, { version: 1, notes: null, basedOnViewId: null, writable: true });
    move(1);
    await expect(second.settle()).resolves.toBe(true);
    expect(second.leaving.getState()).toBe(false);
  });
});

describe('an investigation that was deleted in another tab', () => {
  it('says so, stops retrying, sends nothing more however the canvas changes, and does not hold the person back from leaving', async () => {
    const { writes, move, sync } = rig(() => GONE);
    move(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes).toHaveLength(1);
    expect(sync.status.getState()).toEqual({ kind: 'deleted' });
    await vi.advanceTimersByTimeAsync(RETRY_STEADY_MS * 3);
    expect(writes).toHaveLength(1);
    move(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(writes).toHaveLength(1);
    expect(await sync.settle()).toBe(true);
  });
});

describe('discarding the draft of a deleted investigation', () => {
  it('drops the changes that wait and sends nothing, neither on the timer nor as the investigation is left', async () => {
    const { writes, move, sync, state } = rig();
    move(1);
    sync.discard(ID);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    state.forget(ID);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(writes).toHaveLength(0);
  });
});

