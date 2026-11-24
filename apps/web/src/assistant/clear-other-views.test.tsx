import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantThreadResponse, AssistantTurnAnswer } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { createClientState } from '../state/client-state.js';
import { followClearNotice } from './assistant-binder.js';
import { createAssistantSession } from './assistant-session.js';
import { harness, REFUSE, typeAndSend, RECORD } from './assistant-kit.js';
import { browserClearNotice, investigationOfNotice, type ClearNotice } from './clear-notice.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const ID = '0192f000-0000-7000-8000-0000000000aa';
const PERSON = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const stored = (epoch: number): AssistantThreadResponse => ({ turns: [{ id: ID, seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'ask', outcome: 'answered', intent: 'shared-devices', citedElements: 3, steps: 1 }], earlierTurns: 0, previousThreadClearedAt: null, epoch });
const empty = (epoch: number): AssistantThreadResponse => ({ turns: [], earlierTurns: 0, previousThreadClearedAt: null, epoch });
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

/** The sessions of one browser: a notice of a person reaches that person's other sessions and not the sender, as a channel per person does. */
function bus() {
  const listeners = new Set<{ readonly owner: object; readonly principalId: string; readonly hear: (id: string) => void }>();
  const sent: string[] = [];
  return {
    sent,
    noticeFor(owner: object): ClearNotice {
      return {
        announce(principalId, id) {
          sent.push(`${principalId}:${id}`);
          for (const listener of listeners) if (listener.owner !== owner && listener.principalId === principalId) listener.hear(id);
        },
        listen(principalId, hear) {
          const listener = { owner, principalId, hear };
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      };
    },
  };
}

function window2(channel: ReturnType<typeof bus>, thread: () => AssistantThreadResponse, turnEpoch?: number) {
  const h = harness(async () => ok(REFUSE), 1000, async () => ok(thread()), false, undefined, undefined, { notice: channel.noticeFor({}), ...(turnEpoch === undefined ? {} : { turnEpoch }) });
  h.session.store.setState({ ...h.session.store.getState(), principalId: PERSON });
  const stop = followClearNotice(h.state, h.session);
  return { ...h, stop };
}

describe('a clearing seen from another window of the same person', () => {
  it('empties the second window, which makes no call of its own to the clearing route', async () => {
    const channel = bus();
    let serverCleared = false;
    const read = (): AssistantThreadResponse => (serverCleared ? empty(1) : stored(0));
    const first = window2(channel, read);
    const second = window2(channel, read);
    const view = render(<div><div data-testid="first">{first.tree()}</div><div data-testid="second">{second.tree()}</div></div>);
    await waitFor(() => expect(within(view.getByTestId('second')).getByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeTruthy());
    serverCleared = true;
    await userEvent.click(within(view.getByTestId('first')).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    await waitFor(() => expect(within(view.getByTestId('second')).queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeNull());
    expect(within(view.getByTestId('second')).getByText(ASSISTANT_COPY.introTitle)).toBeTruthy();
    expect(second.clears).toEqual([]);
    expect(first.clears).toEqual(['inv-1']);
    expect(channel.sent).toHaveLength(1);
    first.stop();
    second.stop();
  });

  it('keeps a turn made after the clearing when the notice is late, whether the turn is pending or answered', async () => {
    const channel = bus();
    let server: AssistantThreadResponse = stored(0);
    const gate = deferred<ApiResult<AssistantTurnAnswer>>();
    const sender = {};
    const second = harness(async () => gate.promise, 1000, async () => ok(server), false, undefined, undefined, { notice: channel.noticeFor({}), turnEpoch: 1 });
    second.session.store.setState({ ...second.session.store.getState(), principalId: PERSON });
    const stop = followClearNotice(second.state, second.session);
    render(second.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    await typeAndSend('after');
    await waitFor(() => expect(second.session.store.getState().turns[0]?.threadEpoch).toBe(1));
    server = empty(1);
    act(() => channel.noticeFor(sender).announce(PERSON, 'inv-1'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeNull());
    expect(second.session.store.getState().turns.map((turn) => turn.message)).toEqual(['after']);
    await act(async () => gate.resolve(ok(REFUSE)));
    await waitFor(() => expect(second.session.store.getState().turns[0]?.outcome.kind).not.toBe('pending'));
    act(() => channel.noticeFor(sender).announce(PERSON, 'inv-1'));
    await waitFor(() => expect(second.session.stored.getState().kind).toBe('ready'));
    expect(second.session.store.getState().turns.map((turn) => turn.message)).toEqual(['after']);
    stop();
  });

  it('ignores a notice for another investigation', async () => {
    const channel = bus();
    const second = window2(channel, () => stored(0));
    render(second.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    act(() => channel.noticeFor({}).announce(PERSON, 'another-investigation'));
    await Promise.resolve();
    expect(second.session.stored.getState().kind).toBe('ready');
    expect(second.reads).toEqual(['inv-1']);
    second.stop();
  });
});

describe('a clearing seen by the session of another person', () => {
  it('is ignored, and is heard once the session belongs to the same person', async () => {
    const channel = bus();
    const state = createClientState();
    state.bindSource('a');
    state.show({ id: 'inv-1', sourceId: 'a', record: RECORD, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
    const session = createAssistantSession(channel.noticeFor({}));
    session.stored.setState({ kind: 'ready', thread: stored(0) });
    session.store.setState({ ...session.store.getState(), principalId: 'person-b' });
    const stop = followClearNotice(state, session);
    channel.noticeFor({}).announce('person-a', 'inv-1');
    expect(session.invalidated.token).toBe(0);
    session.store.setState({ ...session.store.getState(), principalId: 'person-a' });
    channel.noticeFor({}).announce('person-a', 'inv-1');
    expect([session.invalidated.token, session.refreshing.pending, session.stored.getState().kind]).toEqual([1, true, 'ready']);
    session.store.setState({ ...session.store.getState(), principalId: 'person-b' });
    channel.noticeFor({}).announce('person-a', 'inv-1');
    expect(session.invalidated.token).toBe(1);
    stop();
  });
});

describe('a notice that comes while the thread is being read or shown', () => {
  it('drops a read that began before the clearing when it arrives, and reads again', async () => {
    const channel = bus();
    const first = deferred<ApiResult<AssistantThreadResponse>>();
    let reads = 0;
    const second = harness(async () => ok(REFUSE), 1000, async () => (++reads === 1 ? first.promise : ok(empty(1))), false, undefined, undefined, { notice: channel.noticeFor({}) });
    second.session.store.setState({ ...second.session.store.getState(), principalId: PERSON });
    const stop = followClearNotice(second.state, second.session);
    render(second.tree());
    await waitFor(() => expect(second.session.stored.getState().kind).toBe('loading'));
    act(() => channel.noticeFor({}).announce(PERSON, 'inv-1'));
    await act(async () => first.resolve(ok(stored(0))));
    await waitFor(() => expect(second.session.stored.getState().kind).toBe('ready'));
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeNull();
    expect(reads).toBe(2);
    stop();
  });

  it('keeps the thread on screen when the read that the notice asked for fails', async () => {
    const channel = bus();
    let reads = 0;
    const second = harness(async () => ok(REFUSE), 1000, async () => (++reads === 1 ? ok(stored(0)) : { ok: false, failure: { code: 'INTERNAL_ERROR', message: 'x', retryable: false, traceId: 't' } }), false, undefined, undefined, { notice: channel.noticeFor({}) });
    second.session.store.setState({ ...second.session.store.getState(), principalId: PERSON });
    const stop = followClearNotice(second.state, second.session);
    render(second.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    act(() => channel.noticeFor({}).announce(PERSON, 'inv-1'));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).not.toBeNull();
    expect(second.session.stored.getState().kind).toBe('ready');
    stop();
  });

  it('reads again when the panel is opened later, if the notice came while it was closed', async () => {
    const channel = bus();
    let server: AssistantThreadResponse = stored(0);
    const h = harness(async () => ok(REFUSE), 1000, async () => ok(server), false, undefined, undefined, { notice: channel.noticeFor({}) });
    h.session.store.setState({ ...h.session.store.getState(), principalId: PERSON });
    const stop = followClearNotice(h.state, h.session);
    const view = render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    view.unmount();
    server = empty(1);
    channel.noticeFor({}).announce(PERSON, 'inv-1');
    expect(h.session.refreshing.pending).toBe(true);
    render(h.tree());
    await waitFor(() => expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeNull());
    expect(h.session.refreshing.pending).toBe(false);
    stop();
  });
});

describe('the notice and the channel of the browser', () => {
  it('holds the investigation’s id and nothing else, in a channel of its own for each person, and the listener closes its channel when it stops', () => {
    const posted: { readonly name: string; readonly data: unknown }[] = [];
    const closed: string[] = [];
    class Fake {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(readonly name: string) {}
      postMessage(data: unknown): void {
        posted.push({ name: this.name, data });
      }
      close(): void {
        closed.push(this.name);
      }
    }
    vi.stubGlobal('BroadcastChannel', Fake);
    const notice = browserClearNotice();
    notice?.announce('person-a', 'inv-1');
    notice?.announce('person-b', 'inv-1');
    expect(posted).toEqual([
      { name: 'neburyx-assistant-chat-cleared:person-a', data: { investigationId: 'inv-1' } },
      { name: 'neburyx-assistant-chat-cleared:person-b', data: { investigationId: 'inv-1' } },
    ]);
    notice?.listen('person-a', () => undefined)();
    expect(closed).toEqual(['neburyx-assistant-chat-cleared:person-a']);
  });

  it('reads only a message that is a notice', () => {
    for (const data of [undefined, null, 'inv-1', [], {}, { investigationId: 4 }, { investigationId: '' }, { investigationId: 'inv-1', text: 'x' }]) expect(investigationOfNotice(data)).toBeUndefined();
    expect(investigationOfNotice({ investigationId: 'inv-1' })).toBe('inv-1');
  });

  it('is none where the browser has no channel, and a channel that fails changes nothing', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    expect(browserClearNotice()).toBeUndefined();
    vi.stubGlobal('BroadcastChannel', class { constructor() { throw new Error('blocked'); } });
    const notice = browserClearNotice();
    expect(() => notice?.announce('person-a', 'inv-1')).not.toThrow();
    expect(notice?.listen('person-a', () => undefined)).toBeTypeOf('function');
  });
});
