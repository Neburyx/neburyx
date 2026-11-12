import { describe, expect, it } from 'vitest';
import type { EdgeDetail, StoredEdgeRef } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { FIXTURE_RECORD } from '../dev/fixture-loader.js';
import { createClientState } from '../state/client-state.js';
import { ref as elementRef } from '../state/test-data.js';
import { createEdgeReadStore, dropReadsOnNewEpoch } from './edge-read.js';

const REF: StoredEdgeRef = { sourceId: 'a', type: 'OWNS', from: 'x', to: 'y', stableId: 'e1' };

function rigged() {
  const calls: Array<{ readonly mask: boolean; readonly signal: AbortSignal | undefined }> = [];
  const client = fakeClient({ getEdge: (_ref, options, signal) => new Promise<ApiResult<EdgeDetail>>(() => void calls.push({ mask: options?.mask === true, signal })) });
  const person = { now: 'p1' };
  const investigation = { now: 'i1' };
  return { calls, person, investigation, store: createEdgeReadStore(client, () => person.now, () => investigation.now) };
}

describe('the edge read store', () => {
  it('makes one read for one person, investigation, reference and masking, and another for any other', () => {
    const { store, calls, person, investigation } = rigged();
    expect(store.forEdge(REF, false)).toBe(store.forEdge(REF, false));
    store.forEdge(REF, true);
    investigation.now = 'i2';
    store.forEdge(REF, false);
    person.now = 'p2';
    store.forEdge(REF, false);
    expect(calls.map((call) => call.mask)).toEqual([false, true, false, false]);
  });

  it('cancels a read in flight only when the last part that holds it lets go', () => {
    const { store, calls } = rigged();
    store.forEdge(REF, false);
    const releaseFirst = store.hold(REF, false);
    const releaseSecond = store.hold(REF, false);
    releaseFirst();
    expect(calls[0]?.signal?.aborted).toBe(false);
    releaseSecond();
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it('cancels what is in flight and drops every held read on clear, so the next ask reads again', () => {
    const { store, calls } = rigged();
    store.forEdge(REF, false);
    store.clear();
    expect(calls[0]?.signal?.aborted).toBe(true);
    store.forEdge(REF, false);
    expect(calls).toHaveLength(2);
  });
});

describe('dropping the held reads', () => {
  function held() {
    const { store, calls } = rigged();
    const state = createClientState();
    state.bindSource('a');
    state.describeInvestigation(FIXTURE_RECORD);
    const stop = dropReadsOnNewEpoch(state, store);
    store.forEdge(REF, false);
    return { store, calls, state, stop };
  }

  it('keeps a read in flight and its answer when the graph changes: a load, an expansion or a hide', () => {
    const { store, calls, state, stop } = held();
    state.setLoaded([], [elementRef('a', 'x', '1')], []);
    state.setLoaded([], [], []);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal?.aborted).toBe(false);
    store.forEdge(REF, false);
    expect(calls).toHaveLength(1);
    stop();
  });

  it('drops the held reads when the masking changes and when the investigation shown changes, and not when either is set to what it was', () => {
    const { store, calls, state, stop } = held();
    state.setMask(false);
    state.describeInvestigation(FIXTURE_RECORD);
    expect(calls[0]?.signal?.aborted).toBe(false);
    state.setMask(true);
    expect(calls[0]?.signal?.aborted).toBe(true);
    store.forEdge(REF, true);
    expect(calls).toHaveLength(2);
    state.show({ id: '0192f000-0000-7000-8000-0000000000ab', sourceId: 'a', record: FIXTURE_RECORD, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
    expect(calls[1]?.signal?.aborted).toBe(true);
    store.forEdge(REF, true);
    expect(calls).toHaveLength(3);
    stop();
  });

  it('stops dropping once it is stopped', () => {
    const { store, calls, state, stop } = held();
    stop();
    state.setMask(true);
    store.forEdge(REF, false);
    expect(calls).toHaveLength(1);
  });
});

describe('the answered reads of the edge read store', () => {
  const DETAIL = { semantics: 'stored' } as unknown as EdgeDetail;

  function answering() {
    const person = { now: 'p1' };
    const investigation = { now: 'i1' };
    const client = fakeClient({ getEdge: async () => ({ ok: true, value: DETAIL }) });
    return { investigation, store: createEdgeReadStore(client, () => person.now, () => investigation.now) };
  }

  it('holds an answered read, and none before it answers or for another masking or investigation', async () => {
    const { store, investigation } = answering();
    const request = store.forEdge(REF, false);
    expect(store.held(REF, false)).toBeUndefined();
    request.reload();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.held(REF, false)).toBe(DETAIL);
    expect(store.held(REF, true)).toBeUndefined();
    investigation.now = 'i2';
    expect(store.held(REF, false)).toBeUndefined();
  });

  it('counts each answer once, and changes the count when the reads are dropped, so what is drawn from them is drawn again', async () => {
    const { store } = answering();
    store.forEdge(REF, false).reload();
    await Promise.resolve();
    await Promise.resolve();
    const afterAnswer = store.answers.getState();
    expect(afterAnswer).toBe(1);
    store.clear();
    expect(store.answers.getState()).toBe(2);
    expect(store.held(REF, false)).toBeUndefined();
  });
});
