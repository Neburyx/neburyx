import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantThreadResponse, GraphEdge, ReadRefsRequest, ReadRefsResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { AGGREGATE_REFS_WAIT_MS, READ_WAIT_MS } from '../api/read-wait.js';
import { edge, node, ref } from '../state/test-data.js';
import { createPanelRegistry } from '../workspace/panel-registry.js';
import { installFakeBroadcastChannel } from '../windows/fake-broadcast.js';
import { forgetOpenedWindows } from '../windows/pop-out.js';
import { createWindowChannel, type WindowChannel } from '../windows/window-channel.js';
import { bindAssistantPanel } from './assistant-binder.js';
import { harness, REFUSE, type ReadRefsCall, type ThreadCall } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

let restore: () => void = () => undefined;
let others: WindowChannel[] = [];
let unbind: () => void = () => undefined;
beforeEach(() => {
  vi.useFakeTimers();
  restore = installFakeBroadcastChannel();
});
afterEach(() => {
  cleanup();
  unbind();
  unbind = () => undefined;
  for (const other of others) other.close();
  others = [];
  forgetOpenedWindows();
  restore();
  vi.useRealTimers();
});

const wait = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
/** Lets the reads that come one after another be made, with no time passing: each waits for the panel to be drawn again. */
const drawn = async () => {
  for (let round = 0; round < 5; round += 1) await wait();
};
const hang = () => new Promise<never>(() => undefined);
const press = async (element: HTMLElement) => {
  await act(async () => void fireEvent.click(element));
  await drawn();
};
const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const tryAgain = () => screen.getByRole('button', { name: ASSISTANT_COPY.tryAgain });
const storedTurn = (seq: number): AssistantThreadResponse['turns'][number] => ({ id: `0192f000-0000-7000-8000-0000000000a${seq}`, seq, at: '2026-11-18T10:00:00.000Z', route: 'ask', outcome: 'answered', intent: 'shared-devices', citedElements: 3, steps: 1 });
const thread = (seqs: readonly number[], epoch = 0): AssistantThreadResponse => ({ turns: seqs.map(storedTurn), earlierTurns: 0, previousThreadClearedAt: null, epoch });
const rows = (): number => document.querySelectorAll('.assistant-stored-row').length;
const heading = () => screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading });

async function open(read: ThreadCall, refs?: ReadRefsCall) {
  const h = harness(async () => ok(REFUSE), 1000, read, false, refs);
  unbind = bindAssistantPanel(h.state, createPanelRegistry(), h.session);
  render(h.tree());
  await drawn();
  return h;
}

/** A read of the thread whose second call gets no answer; `signals` holds the signal of each call. */
function secondHangs(later: AssistantThreadResponse) {
  const signals: (AbortSignal | undefined)[] = [];
  const read: ThreadCall = (_id, signal) => {
    signals.push(signal);
    if (signals.length === 2) return hang();
    return Promise.resolve(ok(signals.length === 1 ? thread([1]) : later));
  };
  return { read, signals };
}

describe('the stored thread whose read gets no answer', () => {
  it('ends the first read at the bound, with Try again, after which a later read starts', async () => {
    let reads = 0;
    const h = await open(() => (++reads === 1 ? hang() : Promise.resolve(ok(thread([1])))));
    await wait(READ_WAIT_MS - 1);
    expect(screen.getByText(ASSISTANT_COPY.storedLoading)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.storedFailed)).toBeNull();
    await wait(1);
    expect(screen.getByText(ASSISTANT_COPY.storedFailed)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.storedLoading)).toBeNull();
    expect(h.session.open.size).toBe(0);
    await press(tryAgain());
    expect(h.reads).toHaveLength(2);
    expect(rows()).toBe(1);
    expect(screen.queryByText(ASSISTANT_COPY.storedFailed)).toBeNull();
  });

  it('stops waiting without a message for the reread made when the window is shown, and a later reread is applied', async () => {
    const parts = secondHangs(thread([], 1));
    const h = await open(parts.read);
    await act(async () => void window.dispatchEvent(new Event('focus')));
    expect(parts.signals).toHaveLength(2);
    await wait(READ_WAIT_MS - 1);
    expect(parts.signals[1]?.aborted).toBe(false);
    expect(h.session.open.size).toBe(1);
    await wait(1);
    expect(parts.signals[1]?.aborted).toBe(true);
    expect(h.session.open.size).toBe(0);
    expect(rows()).toBe(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(ASSISTANT_COPY.storedFailed)).toBeNull();
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await drawn();
    expect(parts.signals).toHaveLength(3);
    expect(heading()).toBeNull();
  });

  it('stops waiting without a message for the reload another window asked for, and does not block a later one', async () => {
    const parts = secondHangs(thread([1, 2]));
    const h = await open(parts.read);
    const other = createWindowChannel({ principalId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', investigationId: 'inv-1', sourceId: 'a' });
    others.push(other);
    await act(async () => other.announceThreadChanged());
    await drawn();
    expect(parts.signals).toHaveLength(2);
    await wait(READ_WAIT_MS - 1);
    expect(parts.signals[1]?.aborted).toBe(false);
    await wait(1);
    expect(parts.signals[1]?.aborted).toBe(true);
    expect(h.session.open.size).toBe(0);
    expect(rows()).toBe(1);
    expect(screen.queryByRole('alert')).toBeNull();
    // a read given up ends the waits: nothing more is read until something asks
    await wait(10_000);
    expect(parts.signals).toHaveLength(2);
    await act(async () => other.announceThreadChanged());
    await drawn();
    expect(parts.signals).toHaveLength(3);
    expect(rows()).toBe(2);
  });
});

describe('the stored thread whose read gets no answer, and whose next read finds the access lost', () => {
  const lost: ApiResult<AssistantThreadResponse> = { ok: false, failure: { code: 'NOT_FOUND', message: 'x', retryable: false, traceId: 't' } };
  const focus = async () => {
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await drawn();
  };
  const expectCleared = (h: Awaited<ReturnType<typeof open>>) => {
    expect(screen.getByRole('alert').textContent).toBe(ASSISTANT_COPY.accessLost);
    expect(h.session.stored.getState()).toEqual({ kind: 'denied' });
    expect(rows()).toBe(0);
    expect(heading()).toBeNull();
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.tryAgain })).toBeNull();
    expect(screen.queryByText(ASSISTANT_COPY.storedFailed)).toBeNull();
    expect(h.session.open.size).toBe(0);
  };

  it('says the first read failed at the bound, and clears the thread with the notice when Try again finds the access lost', async () => {
    let reads = 0;
    const h = await open(() => (++reads === 1 ? hang() : Promise.resolve(lost)));
    await wait(READ_WAIT_MS);
    expect(screen.getByRole('alert').textContent).toBe(`${ASSISTANT_COPY.storedFailed} ${ASSISTANT_COPY.tryAgain}`);
    await press(tryAgain());
    expectCleared(h);
    await focus();
    expect(reads).toBe(2);
  });

  it.each([
    ['the window is shown', focus],
    [
      'another window says the thread changed',
      async () => {
        const other = createWindowChannel({ principalId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', investigationId: 'inv-1', sourceId: 'a' });
        others.push(other);
        await act(async () => other.announceThreadChanged());
        await drawn();
      },
    ],
  ])('keeps the thread when the reread made as %s ends at the bound, and clears it with the notice when the next one finds the access lost', async (_name, reread) => {
    let reads = 0;
    const h = await open(() => (++reads === 1 ? Promise.resolve(ok(thread([1]))) : reads === 2 ? hang() : Promise.resolve(lost)));
    await reread();
    expect(reads).toBe(2);
    await wait(READ_WAIT_MS);
    expect(rows()).toBe(1);
    expect(h.session.stored.getState().kind).toBe('ready');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(h.session.open.size).toBe(0);
    await focus();
    expectCleared(h);
    const made = reads;
    await focus();
    expect(reads).toBe(made);
  });
});

const turnWith = (answer: NonNullable<AssistantThreadResponse['turns'][number]['answer']>, citedElements: number): AssistantThreadResponse => ({
  turns: [{ id: '0192f000-0000-7000-8000-000000000001', seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'view', outcome: 'answered', citedElements, steps: 0, question: 'What links them?', answer }],
  earlierTurns: 0,
  previousThreadClearedAt: null,
});
const A = ref('a', 'type-a', 'ent-1');
const B = ref('a', 'type-a', 'ent-2');
const ENDS = [{ ...node('a', 'ent-1'), display: { title: 'Account One', type: 'type-a' } }, { ...node('a', 'ent-2'), display: { title: 'Account Two', type: 'type-a' } }];
const toggle = () => screen.getByRole('button', { name: new RegExp(`^${ASSISTANT_COPY.sources} · `) });

describe('the elements a stored answer cites, whose read gets no answer', () => {
  it('ends the read of the stored values at the bound, with Try again, which reads them', async () => {
    const answer = turnWith({ blocks: [{ kind: 'sentences', items: [{ item: { state: 'segments', segments: [{ literal: 'The holder is ' }, { element: A, property: 'holder' }, { literal: '.' }] }, cites: [A] }] }] }, 1);
    const value: ReadRefsResponse = { nodes: [{ ...node('a', 'ent-1'), properties: [{ key: 'holder', value: 'Jordan Lee', dataClass: 'text', masked: false }] }], edges: [], missing: { entities: [], edges: [] } };
    let reads = 0;
    const h = await open(async () => ok(answer), () => (++reads === 1 ? hang() : Promise.resolve(ok(value))));
    await wait(READ_WAIT_MS - 1);
    expect(screen.getByText(ASSISTANT_COPY.valuesLoading)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.valuesFailed)).toBeNull();
    await wait(1);
    expect(screen.getByText(ASSISTANT_COPY.valuesFailed)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.valuesLoading)).toBeNull();
    await press(tryAgain());
    expect(h.askedRefs).toHaveLength(2);
    expect(screen.getByText(/The holder is Jordan Lee\./)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.valuesFailed)).toBeNull();
  });

  it('ends the reads of the sources at the bound, with Try again, which reads them', async () => {
    const stored = edge('a', 'rel-1', 'ent-1', 'ent-2');
    const answer = turnWith({ blocks: [{ kind: 'sentences', items: [{ item: { state: 'text', text: 'They are linked.' }, cites: [A, B, stored.ref] }] }] }, 3);
    let reads = 0;
    // one read for the entities and one for the relationship
    const h = await open(async () => ok(answer), () => (++reads <= 2 ? hang() : Promise.resolve(ok({ nodes: ENDS, edges: [stored], missing: { entities: [], edges: [] } }))));
    await press(toggle());
    await wait(READ_WAIT_MS - 1);
    expect(screen.getByText(ASSISTANT_COPY.sourcesLoading)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.sourcesFailed)).toBeNull();
    await wait(1);
    expect(screen.getByText(ASSISTANT_COPY.sourcesFailed)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.sourcesLoading)).toBeNull();
    await press(tryAgain());
    expect(h.askedRefs).toHaveLength(4);
    expect(screen.getByRole('button', { name: /^Sources: 1, Account One/ })).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.sourcesFailed)).toBeNull();
  });

  it('ends the read of an aggregate relationship at the longer bound, with Try again, and takes the answer that then comes after the usual wait', async () => {
    const summed: GraphEdge = { ...edge('a', 'rel-1', 'ent-1', 'ent-2'), ref: { sourceId: 'a', aggregate: { type: 'rel-a', from: A, to: B } } };
    const answer = turnWith({ blocks: [{ kind: 'sentences', items: [{ item: { state: 'text', text: 'They are linked.' }, cites: [summed.ref] }] }] }, 1);
    let finish: (value: ApiResult<ReadRefsResponse>) => void = () => undefined;
    const signals: (AbortSignal | undefined)[] = [];
    let aggregates = 0;
    const refs = (request: ReadRefsRequest, signal: AbortSignal | undefined): Promise<ApiResult<ReadRefsResponse>> => {
      if (request.aggregates.length === 0) return Promise.resolve(ok({ nodes: ENDS, edges: [], missing: { entities: [], edges: [] } }));
      signals.push(signal);
      return ++aggregates === 1 ? hang() : new Promise((resolve) => (finish = resolve));
    };
    await open(async () => ok(answer), refs);
    await press(toggle());
    await wait(AGGREGATE_REFS_WAIT_MS - 1);
    expect(screen.getByText(ASSISTANT_COPY.sourcesLoading)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.sourcesFailed)).toBeNull();
    await wait(1);
    expect(screen.getByText(ASSISTANT_COPY.sourcesFailed)).toBeTruthy();
    await press(tryAgain());
    expect(aggregates).toBe(2);
    await wait(READ_WAIT_MS + 5000);
    expect(signals[1]?.aborted).toBe(false);
    expect(screen.queryByText(ASSISTANT_COPY.sourcesFailed)).toBeNull();
    await act(async () => finish(ok({ nodes: [], edges: [summed], missing: { entities: [], edges: [] } })));
    await drawn();
    expect(screen.getByText(/Account One → Account Two · rel-a/)).toBeTruthy();
  });
});
