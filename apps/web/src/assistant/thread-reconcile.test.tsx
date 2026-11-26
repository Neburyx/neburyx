import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantThreadResponse, AssistantTurnAnswer } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { createAssistantSession, type Turn } from './assistant-session.js';
import { harness, REFUSE, typeAndSend } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';
import { reloadThread, rereadThread, takeRead, turnsAfterRead } from './thread-reconcile.js';

afterEach(cleanup);

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const ID = '0192f000-0000-7000-8000-0000000000aa';
const stored = (epoch: number): AssistantThreadResponse => ({ turns: [{ id: ID, seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'ask', outcome: 'answered', intent: 'shared-devices', citedElements: 3, steps: 1 }], earlierTurns: 0, previousThreadClearedAt: null, epoch });
const empty = (epoch: number): AssistantThreadResponse => ({ turns: [], earlierTurns: 0, previousThreadClearedAt: null, epoch });
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};
const shown = async (): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};
const turnOf = (id: number, over: Partial<Turn> = {}): Turn => ({ id, message: `q${id}`, outcome: { kind: 'pending', call: 'message' }, ...over });

describe('what the live turns of a window become when a read tells the count', () => {
  it('after a rise keeps a turn whose count is the read’s or higher, drops one with a lower count and a settled one with none, and holds a pending one with none, marked unverified', () => {
    const turns = [turnOf(1, { threadEpoch: 0 }), turnOf(2, { threadEpoch: 1 }), turnOf(3, { threadEpoch: 2 }), turnOf(4), turnOf(5, { outcome: { kind: 'cancelled' } })];
    const { kept, dropped } = turnsAfterRead(turns, 1, true);
    expect(kept.map((turn) => [turn.id, turn.unverified])).toEqual([[2, undefined], [3, undefined], [4, true]]);
    expect(dropped.map((turn) => turn.id)).toEqual([1, 5]);
  });

  it('on a first read keeps a settled turn with no count, and marks a pending one unverified only when the count is above zero', () => {
    const turns = [turnOf(1), turnOf(2, { outcome: { kind: 'cancelled' } })];
    expect(turnsAfterRead(turns, 0, false).kept.map((turn) => turn.unverified)).toEqual([undefined, undefined]);
    expect(turnsAfterRead(turns, 2, false).kept.map((turn) => turn.unverified)).toEqual([true, undefined]);
    expect(turnsAfterRead([turnOf(3, { threadEpoch: 0 })], 2, false).dropped.map((turn) => turn.id)).toEqual([3]);
  });
});

describe('a read of the thread taken by a session', () => {
  it('changes nothing for a read with no count or the same count, rejects a lower one, and learns a higher one', () => {
    const session = createAssistantSession(null);
    expect(takeRead(session, { ...empty(0), epoch: undefined })).toMatchObject({ show: true, replaces: false });
    expect(takeRead(session, empty(2))).toMatchObject({ show: true, replaces: false });
    expect(session.known).toEqual({ epoch: 2, seen: 2 });
    expect(takeRead(session, empty(2))).toMatchObject({ show: true, replaces: false });
    expect(takeRead(session, empty(1))).toMatchObject({ show: false });
    expect(session.known).toEqual({ epoch: 2, seen: 2 });
    expect(takeRead(session, empty(3))).toMatchObject({ show: true, replaces: true });
    expect(session.known).toEqual({ epoch: 3, seen: 3 });
  });

  it('prunes the turns of before even on the first read, and ends their requests', () => {
    const session = createAssistantSession(null);
    const controller = new AbortController();
    session.requests.set(1, controller);
    session.store.setState({ ...session.store.getState(), turns: [turnOf(1, { threadEpoch: 0 }), turnOf(2, { threadEpoch: 1 })] });
    expect(takeRead(session, empty(1))).toMatchObject({ show: true, replaces: false });
    expect(session.store.getState().turns.map((turn) => turn.id)).toEqual([2]);
    expect(controller.signal.aborted).toBe(true);
  });

  it('rejects a read that is older than a count a turn’s response has told', () => {
    const session = createAssistantSession(null);
    session.known.seen = 4;
    expect(takeRead(session, empty(3))).toMatchObject({ show: false });
    expect(takeRead(session, empty(4))).toMatchObject({ show: true });
  });

  it('forgets the counts when another investigation or another person is shown', () => {
    const session = createAssistantSession(null);
    session.clear({ investigationId: 'inv-1', principalId: 'person-a' });
    takeRead(session, empty(4));
    session.clear({ investigationId: 'inv-2' });
    expect(session.known).toEqual({ epoch: undefined, seen: undefined });
    takeRead(session, empty(5));
    session.clear({ principalId: 'person-b' });
    expect(session.known).toEqual({ epoch: undefined, seen: undefined });
    takeRead(session, empty(6));
    session.clear({ mask: true });
    expect(session.known).toEqual({ epoch: 6, seen: 6 });
  });
});

describe('a read again that finds the access lost', () => {
  const lost = async () => ({ ok: false as const, failure: { code: 'NOT_FOUND' as const, message: 'x', retryable: false, traceId: 't' } });
  const shownSession = () => {
    const session = createAssistantSession(null);
    session.stored.setState({ kind: 'ready', thread: stored(0) });
    session.store.setState({ ...session.store.getState(), turns: [turnOf(1)], input: 'typed' });
    return session;
  };

  it.each([
    ['a reread', rereadThread],
    ['a reload', reloadThread],
  ])('takes the thread, the live turns and the typed text of %s away, with the notice', async (_name, read) => {
    const session = shownSession();
    await read(session, lost);
    expect(session.stored.getState()).toEqual({ kind: 'denied' });
    expect(session.store.getState()).toMatchObject({ turns: [], input: '', notice: { kind: 'access-lost' } });
  });

  it('says to a reload that it failed, so that nothing is waited for', async () => {
    expect(await reloadThread(shownSession(), lost)).toEqual({ failed: true, held: undefined });
  });

  it.each([
    ['a reread', rereadThread],
    ['a reload', reloadThread],
  ])('is ignored when the session was cleared while %s was out', async (_name, read) => {
    const session = shownSession();
    await read(session, async () => {
      session.clear({ investigationId: 'inv-2' });
      return lost();
    });
    expect(session.store.getState().notice).toBeUndefined();
    expect(session.stored.getState()).not.toEqual({ kind: 'denied' });
  });
});

describe('a window that missed the notice of a clearing', () => {
  it('shows the server’s empty thread, with its stored and live turns gone, when the window is shown again', async () => {
    let server: AssistantThreadResponse = stored(0);
    const h = harness(async () => ok(REFUSE), 1000, async () => ok(server), false, undefined, undefined, { turnEpoch: 0 });
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    await typeAndSend('who?');
    await waitFor(() => expect(h.session.store.getState().turns[0]?.outcome.kind).not.toBe('pending'));
    expect(h.session.store.getState().turns[0]?.threadEpoch).toBe(0);
    server = empty(1);
    await shown();
    await waitFor(() => expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeNull());
    expect(h.session.store.getState().turns).toEqual([]);
    expect(screen.getByText(ASSISTANT_COPY.introTitle)).toBeTruthy();
    expect(h.session.known.epoch).toBe(1);
  });

  it('ends a pending turn from before the clearing and removes its question', async () => {
    let server: AssistantThreadResponse = stored(0);
    const signals: AbortSignal[] = [];
    const gate = deferred<ApiResult<AssistantTurnAnswer>>();
    const h = harness(
      async (_request, signal) => {
        if (signal !== undefined) signals.push(signal);
        return gate.promise;
      },
      1000,
      async () => ok(server),
      false,
      undefined,
      undefined,
      { turnEpoch: 0 },
    );
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    await typeAndSend('before');
    await waitFor(() => expect(h.session.store.getState().turns[0]?.threadEpoch).toBe(0));
    server = empty(1);
    await shown();
    await waitFor(() => expect(h.session.store.getState().turns).toEqual([]));
    expect(signals[0]?.aborted).toBe(true);
    expect(screen.queryByText('before')).toBeNull();
    await act(async () => gate.resolve(ok(REFUSE)));
    expect(h.session.store.getState().turns).toEqual([]);
  });

  it('keeps a turn made after the clearing, pending and then answered, though the read does not list it yet', async () => {
    let server: AssistantThreadResponse = stored(0);
    const signals: AbortSignal[] = [];
    const gate = deferred<ApiResult<AssistantTurnAnswer>>();
    const h = harness(
      async (_request, signal) => {
        if (signal !== undefined) signals.push(signal);
        return gate.promise;
      },
      1000,
      async () => ok(server),
      false,
      undefined,
      undefined,
      { turnEpoch: 1 },
    );
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    await typeAndSend('after');
    await waitFor(() => expect(h.session.store.getState().turns[0]?.threadEpoch).toBe(1));
    server = empty(1);
    await shown();
    await waitFor(() => expect(h.session.known.epoch).toBe(1));
    await waitFor(() => expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeNull());
    expect(h.session.store.getState().turns.map((turn) => turn.message)).toEqual(['after']);
    expect(signals[0]?.aborted).toBe(false);
    await act(async () => gate.resolve(ok(REFUSE)));
    await waitFor(() => expect(h.session.store.getState().turns[0]?.outcome.kind).not.toBe('pending'));
    expect(h.session.store.getState().turns).toHaveLength(1);
  });

  it('holds a pending turn that has no count yet, and drops it when its response says the count is lower than the session’s', async () => {
    let server: AssistantThreadResponse = stored(0);
    const gate = deferred<ApiResult<AssistantTurnAnswer>>();
    let tell: ((count: number) => void) | undefined;
    const h = harness(async () => gate.promise, 1000, async () => ok(server), false, undefined, undefined, {});
    h.client.assistantTurn = async (_request, signal, _onStep, onEpoch) => {
      tell = onEpoch;
      return await gate.promise;
    };
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    await typeAndSend('slow');
    server = empty(1);
    await shown();
    await waitFor(() => expect(h.session.known.epoch).toBe(1));
    expect(h.session.store.getState().turns.map((turn) => turn.message)).toEqual(['slow']);
    await act(async () => tell?.(0));
    expect(h.session.store.getState().turns).toEqual([]);
  });

  it('does not show a read that carries a lower count than the session has heard of', async () => {
    let server: AssistantThreadResponse = stored(3);
    const h = harness(async () => ok(REFUSE), 1000, async () => ok(server));
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    server = empty(2);
    await shown();
    await Promise.resolve();
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).not.toBeNull();
    expect(h.session.known.epoch).toBe(3);
  });

  it('changes nothing on screen when the read shows the same count, and when it fails', async () => {
    let calls = 0;
    const h = harness(async () => ok(REFUSE), 1000, async () => (++calls === 1 ? ok(stored(1)) : calls === 2 ? ok(stored(1)) : { ok: false, failure: { code: 'INTERNAL_ERROR', message: 'x', retryable: false, traceId: 't' } }));
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    await shown();
    await shown();
    expect(calls).toBe(3);
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).not.toBeNull();
  });
});

describe('the counts across a change of person, a first read and a header', () => {
  it('lets the second person’s first read be shown after the first person’s counts, with no second read', async () => {
    let server: AssistantThreadResponse = stored(5);
    const h = harness(async () => ok(REFUSE), 1000, async () => ok(server));
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    expect(h.session.known.epoch).toBe(5);
    server = stored(0);
    act(() => h.session.clear({ principalId: 'another-person' }));
    await waitFor(() => expect(h.session.stored.getState().kind).toBe('ready'));
    expect(h.reads).toHaveLength(2);
    expect(h.session.known).toEqual({ epoch: 0, seen: 0 });
  });

  it('removes a generation-0 pending question that a first read of generation 1 shows is from before', async () => {
    const gate = deferred<ApiResult<AssistantTurnAnswer>>();
    const read = deferred<ApiResult<AssistantThreadResponse>>();
    const h = harness(async () => gate.promise, 1000, async () => read.promise, false, undefined, undefined, { turnEpoch: 0 });
    render(h.tree());
    await typeAndSend('before');
    await waitFor(() => expect(h.session.store.getState().turns[0]?.threadEpoch).toBe(0));
    await act(async () => read.resolve(ok(stored(1))));
    await waitFor(() => expect(h.session.store.getState().turns).toEqual([]));
  });

  it('does not show a read older than the count a turn’s response told', async () => {
    let server: AssistantThreadResponse = stored(0);
    const gate = deferred<ApiResult<AssistantTurnAnswer>>();
    const h = harness(async () => gate.promise, 1000, async () => ok(server), false, undefined, undefined, { turnEpoch: 3 });
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    await typeAndSend('now');
    await waitFor(() => expect(h.session.known.seen).toBe(3));
    server = empty(2);
    await shown();
    await Promise.resolve();
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).not.toBeNull();
    expect(h.session.known.epoch).toBe(0);
  });

  it('does not show as an answer a turn that was kept through a rise with no count told for it', async () => {
    let server: AssistantThreadResponse = stored(0);
    const gate = deferred<ApiResult<AssistantTurnAnswer>>();
    const h = harness(async () => gate.promise, 1000, async () => ok(server));
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    await typeAndSend('unclassified');
    server = empty(1);
    await shown();
    await waitFor(() => expect(h.session.store.getState().turns[0]?.unverified).toBe(true));
    await act(async () => gate.resolve(ok(REFUSE)));
    await waitFor(() => expect(h.session.store.getState().turns).toEqual([]));
  });
});

describe('the thread read again for a panel that comes back', () => {
  const two = (epoch: number): AssistantThreadResponse => ({ ...stored(epoch), turns: [...stored(epoch).turns, { ...(stored(epoch).turns[0] as AssistantThreadResponse['turns'][number]), id: '0192f000-0000-7000-8000-0000000000bb', seq: 2 }] });

  it('shows the turns the server holds, at the same count, without listing a live turn of this window twice', async () => {
    const session = createAssistantSession(null);
    session.known.epoch = 0;
    session.known.seen = 0;
    session.stored.setState({ kind: 'ready', thread: stored(0) });
    session.store.setState({ ...session.store.getState(), turns: [{ ...turnOf(1, { outcome: { kind: 'cancelled' } }), turnIds: [ID] }] });
    await reloadThread(session, async () => ok(two(0)));
    const held = session.stored.getState();
    expect(held.kind === 'ready' ? held.thread.turns.map((turn) => turn.seq) : []).toEqual([2]);
  });

  it('changes nothing when the read fails, when it is from before a clearing this session has heard of, or when the session moved on while it was out', async () => {
    const session = createAssistantSession(null);
    session.known.epoch = 2;
    session.known.seen = 2;
    session.stored.setState({ kind: 'ready', thread: stored(2) });
    const before = session.stored.getState();
    await reloadThread(session, async () => ({ ok: false, failure: { code: 'INTERNAL_ERROR', message: 'x', retryable: false, traceId: 't' } }));
    await reloadThread(session, async () => ok(two(1)));
    await reloadThread(session, async () => {
      session.store.setState({ ...session.store.getState(), epoch: session.store.getState().epoch + 1 });
      return ok(two(2));
    });
    expect(session.stored.getState()).toBe(before);
  });
});
