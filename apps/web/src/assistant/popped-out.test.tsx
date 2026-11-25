import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_REFUSAL_SENTENCES, type AssistantThreadResponse, type AssistantTurnAnswer } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { ApiClientProvider } from '../api/client-context.js';
import { ShellDataProvider } from '../shell/shell-data.js';
import { ClientStateProvider } from '../state/context.js';
import { ToolsProvider } from '../workspace/tool-registry.js';
import { installFakeBroadcastChannel } from '../windows/fake-broadcast.js';
import { createWindowChannel, EXPIRY_MS, type ChannelLike, type WindowChannel, type WindowScope } from '../windows/window-channel.js';
import { harness, REFUSE, typeAndSend } from './assistant-kit.js';
import { AssistantPanel } from './assistant-panel.js';
import { AssistantSessionProvider } from './assistant-session.js';
import { ASSISTANT_COPY } from './copy.js';

const SCOPE: WindowScope = { principalId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', investigationId: 'inv-1', sourceId: 'a' };
const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const storedTurn = (seq: number): AssistantThreadResponse['turns'][number] => ({ id: `0192f000-0000-7000-8000-0000000000a${seq}`, seq, at: '2026-11-18T10:00:00.000Z', route: 'ask', outcome: 'answered', intent: 'shared-devices', citedElements: 3, steps: 1 });
const thread = (...seqs: number[]): AssistantThreadResponse => ({ turns: seqs.map(storedTurn), earlierTurns: 0, previousThreadClearedAt: null });
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

let restore: () => void = () => undefined;
let others: WindowChannel[] = [];
beforeEach(() => {
  restore = installFakeBroadcastChannel();
});
afterEach(() => {
  cleanup();
  for (const other of others) other.close();
  others = [];
  vi.useRealTimers();
  restore();
});

const window2 = (scope: WindowScope = SCOPE): WindowChannel => {
  const channel = createWindowChannel(scope);
  others.push(channel);
  return channel;
};
const body = (): HTMLElement => document.querySelector('.ask-body') as HTMLElement;
const form = (): HTMLElement => document.querySelector('.ask-form') as HTMLElement;
const note = () => screen.queryByText(ASSISTANT_COPY.poppedOutTitle);
const pageOpens = async (channel: WindowChannel): Promise<() => void> => {
  let stop: () => void = () => undefined;
  await act(async () => {
    stop = channel.announce('assistant');
  });
  return () => act(() => stop());
};
const storedTurns = (): number => document.querySelectorAll('[data-stored-turn], .assistant-stored-row').length;

async function panel(threads: AssistantThreadResponse[] = [thread(1)]) {
  const reads: number[] = [];
  const h = harness(async () => ok(REFUSE), 1000, async () => {
    reads.push(reads.length);
    return ok(threads[Math.min(reads.length - 1, threads.length - 1)] as AssistantThreadResponse);
  });
  render(h.tree());
  await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
  return { h, reads };
}

describe('the panel while the page of the chat is open in another window', () => {
  it('does not collapse where there is no channel', async () => {
    restore();
    vi.stubGlobal('BroadcastChannel', undefined);
    await panel();
    expect(note()).toBeNull();
    expect(body().hidden).toBe(false);
    expect(screen.getByRole('button', { name: ASSISTANT_COPY.popOut }).getAttribute('aria-pressed')).toBe('false');
    restore = () => vi.unstubAllGlobals();
  });

  it('keeps its header and shows the note of the frame in place of the thread and the composer, with Pop out pressed and no Clear chat', async () => {
    await panel();
    expect(screen.getByRole('button', { name: ASSISTANT_COPY.clearChat })).toBeTruthy();
    await pageOpens(window2());
    expect(screen.getByText(ASSISTANT_COPY.poppedOutTitle)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.poppedOutBody)).toBeTruthy();
    expect(screen.getByRole('button', { name: ASSISTANT_COPY.showHere })).toBeTruthy();
    expect(body().hidden).toBe(true);
    expect(form().hidden).toBe(true);
    expect(screen.getByRole('button', { name: ASSISTANT_COPY.popOut }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: ASSISTANT_COPY.close })).toBeTruthy();
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.clearChat })).toBeNull();
    expect(document.querySelector('.assistant-panel')?.getAttribute('data-popped-out')).toBe('true');
  });

  it('does not collapse for a page of another investigation or another source', async () => {
    await panel();
    await pageOpens(window2({ ...SCOPE, investigationId: 'inv-2' }));
    await pageOpens(window2({ ...SCOPE, sourceId: 'b' }));
    expect(note()).toBeNull();
    expect(body().hidden).toBe(false);
  });

  it('comes back when the other window closes, and reads the thread once, so that the turns made there are in it', async () => {
    const { reads } = await panel([thread(1), thread(1, 2)]);
    const stop = await pageOpens(window2());
    expect(storedTurns()).toBeGreaterThan(0);
    const before = reads.length;
    await stop();
    expect(note()).toBeNull();
    expect(body().hidden).toBe(false);
    await waitFor(() => expect(reads.length).toBe(before + 1));
    await waitFor(() => expect(document.querySelectorAll('[data-stored-turn]').length + document.querySelectorAll('.assistant-stored-row').length).toBeGreaterThan(1));
  });

  it('comes back when the other window is not heard from for the expiry', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await panel();
    let alive = true;
    const other = createWindowChannel(SCOPE, {
      factory: (name): ChannelLike => {
        const inner = new BroadcastChannel(name) as unknown as ChannelLike;
        return {
          postMessage: (message) => (alive ? inner.postMessage(message) : undefined),
          get onmessage() {
            return inner.onmessage;
          },
          set onmessage(handler) {
            inner.onmessage = handler;
          },
          close: () => inner.close(),
        };
      },
    });
    others.push(other);
    await act(async () => void other.announce('assistant'));
    expect(note()).not.toBeNull();
    alive = false;
    await act(async () => void vi.advanceTimersByTime(EXPIRY_MS + 6000));
    expect(note()).toBeNull();
    expect(body().hidden).toBe(false);
  });

  it('shows the thread and the composer on the button with one read, while the other window stays open, and collapses again when that window closes and a page is opened again', async () => {
    const { reads } = await panel([thread(1), thread(1, 2)]);
    const first = window2();
    const stop = await pageOpens(first);
    const before = reads.length;
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.showHere }));
    expect(note()).toBeNull();
    expect(body().hidden).toBe(false);
    expect(form().hidden).toBe(false);
    await waitFor(() => expect(reads.length).toBe(before + 1));
    expect(screen.getByRole('button', { name: ASSISTANT_COPY.popOut }).getAttribute('aria-pressed')).toBe('true');
    await stop();
    expect(note()).toBeNull();
    await pageOpens(first);
    expect(note()).not.toBeNull();
  });

  it('keeps a turn that is pending when it collapses, and has its answer in the thread when the panel shows again', async () => {
    const gate = deferred<ApiResult<AssistantTurnAnswer>>();
    const h = harness(async () => gate.promise);
    render(h.tree());
    await typeAndSend('who?');
    const stop = await pageOpens(window2());
    expect(note()).not.toBeNull();
    await act(async () => gate.resolve(ok(REFUSE)));
    await stop();
    expect(await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeTruthy();
    expect(document.querySelector('.assistant-thread')).not.toBeNull();
  });

  it('keeps the turns it held when the read made on the return fails', async () => {
    const calls: number[] = [];
    const h = harness(async () => ok(REFUSE), 1000, async () => {
      calls.push(calls.length);
      return calls.length === 1 ? ok(thread(1)) : { ok: false, failure: { code: 'INTERNAL_ERROR', message: 'no', retryable: true, traceId: 'tr' } };
    });
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    const stop = await pageOpens(window2());
    await stop();
    await waitFor(() => expect(calls.length).toBeGreaterThan(1));
    expect(screen.getByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeTruthy();
    expect(body().hidden).toBe(false);
  });

  it('reads again each time the window is shown after a failed read on the return, until one is answered, and then shows the turns made in the other window', async () => {
    const calls: number[] = [];
    const h = harness(async () => ok(REFUSE), 1000, async () => {
      calls.push(calls.length);
      if (calls.length === 2) return { ok: false, failure: { code: 'INTERNAL_ERROR', message: 'no', retryable: true, traceId: 'tr' } };
      return ok(calls.length === 1 ? thread(1) : thread(1, 2));
    });
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    const stop = await pageOpens(window2());
    await stop();
    await waitFor(() => expect(calls.length).toBe(2));
    expect(document.querySelectorAll('[data-stored-turn]').length + document.querySelectorAll('.assistant-stored-row').length).toBe(1);
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(document.querySelectorAll('[data-stored-turn]').length + document.querySelectorAll('.assistant-stored-row').length).toBeGreaterThan(1));
  });

  it('goes back to the note when Pop out cannot reach the window of the page after the chat was shown here, and says nothing more', async () => {
    const blank = { closed: false, focus: vi.fn(), close: vi.fn(), location: { href: 'about:blank' } };
    const open = vi.spyOn(window, 'open').mockReturnValue(blank as unknown as Window);
    await panel();
    await pageOpens(window2());
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.showHere }));
    expect(note()).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.popOut }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(blank.close).toHaveBeenCalledTimes(1);
    expect(note()).not.toBeNull();
    expect(screen.queryByText(ASSISTANT_COPY.popOutRefused)).toBeNull();
  });

  it('closes on Escape and on Close as the open panel does, and moves the focus to the composer when it is restored while the button has it', async () => {
    const h = harness(async () => ok(REFUSE));
    const closed = vi.fn();
    render(
      <ApiClientProvider client={h.client}>
        <ClientStateProvider state={h.state}>
          <ShellDataProvider store={h.shell}>
            <ToolsProvider registry={h.tools}>
              <AssistantSessionProvider value={h.session}>
                <AssistantPanel onClose={closed} />
              </AssistantSessionProvider>
            </ToolsProvider>
          </ShellDataProvider>
        </ClientStateProvider>
      </ApiClientProvider>,
    );
    await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
    const stop = await pageOpens(window2());
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.close }));
    expect(closed).toHaveBeenCalledTimes(1);
    const show = screen.getByRole('button', { name: ASSISTANT_COPY.showHere });
    show.focus();
    await userEvent.keyboard('{Escape}');
    expect(closed).toHaveBeenCalledTimes(2);
    show.focus();
    await stop();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(ASSISTANT_COPY.fieldLabel)));
  });

  it('moves the focus to the composer when the button is pressed', async () => {
    await panel();
    await pageOpens(window2());
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.showHere }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(ASSISTANT_COPY.fieldLabel)));
  });
});
