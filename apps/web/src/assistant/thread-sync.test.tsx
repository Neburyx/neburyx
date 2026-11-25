import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_REFUSAL_SENTENCES, type AssistantThreadResponse, type AssistantTurnAnswer } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { installFakeBroadcastChannel } from '../windows/fake-broadcast.js';
import { forgetOpenedWindows } from '../windows/pop-out.js';
import { createWindowChannel, type WindowChannel, type WindowScope } from '../windows/window-channel.js';
import { harness, REFUSE, typeAndSend } from './assistant-kit.js';
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
const rows = (): number => document.querySelectorAll('[data-stored-turn], .assistant-stored-row').length;

let restore: () => void = () => undefined;
let others: WindowChannel[] = [];
beforeEach(() => {
  restore = installFakeBroadcastChannel();
});
afterEach(() => {
  cleanup();
  for (const other of others) other.close();
  others = [];
  forgetOpenedWindows();
  vi.restoreAllMocks();
  restore();
});
const window2 = (): WindowChannel => {
  const channel = createWindowChannel(SCOPE);
  others.push(channel);
  return channel;
};

describe('the thread of a window while another window shows the chat', () => {
  it('is read again when another window says the thread changed, and shows the turn made there, with nothing sent back', async () => {
    const reads: number[] = [];
    const h = harness(async () => ok(REFUSE), 1000, async () => {
      reads.push(reads.length);
      return ok(reads.length === 1 ? thread(1) : thread(1, 2));
    });
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    expect(rows()).toBe(1);
    const other = window2();
    const echoed = vi.fn();
    other.onThreadChanged(echoed);
    await act(async () => other.announceThreadChanged());
    await waitFor(() => expect(rows()).toBe(2));
    expect(reads).toHaveLength(2);
    expect(echoed).not.toHaveBeenCalled();
  });

  it('reads again after 0.6 s, 1.5 s and 3 s while the server has not stored the turn yet, shows it when it appears, and stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let reads = 0;
      let stored = false;
      const h = harness(async () => ok(REFUSE), 1000, async () => {
        reads += 1;
        return ok(stored ? thread(1, 2) : thread(1));
      });
      render(h.tree());
      await act(async () => void (await vi.advanceTimersByTimeAsync(50)));
      expect(rows()).toBe(1);
      const before = reads;
      const other = window2();
      await act(async () => other.announceThreadChanged());
      expect(reads).toBe(before + 1);
      expect(rows()).toBe(1);
      await act(async () => void (await vi.advanceTimersByTimeAsync(700)));
      expect(reads).toBe(before + 2);
      stored = true;
      await act(async () => void (await vi.advanceTimersByTimeAsync(1600)));
      expect(reads).toBe(before + 3);
      expect(rows()).toBe(2);
      await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
      expect(reads).toBe(before + 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the third wait when the server never holds another turn, and keeps what it shows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let reads = 0;
      const h = harness(async () => ok(REFUSE), 1000, async () => {
        reads += 1;
        return ok(thread(1));
      });
      render(h.tree());
      await act(async () => void (await vi.advanceTimersByTimeAsync(50)));
      const before = reads;
      const other = window2();
      await act(async () => other.announceThreadChanged());
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
      expect(reads).toBe(before + 4);
      expect(rows()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts again from the newest notice and does not run two waits at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let reads = 0;
      const h = harness(async () => ok(REFUSE), 1000, async () => {
        reads += 1;
        return ok(thread(1));
      });
      render(h.tree());
      await act(async () => void (await vi.advanceTimersByTimeAsync(50)));
      const before = reads;
      const other = window2();
      await act(async () => other.announceThreadChanged());
      await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
      await act(async () => other.announceThreadChanged());
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
      // the first notice's read, the second notice's read, and the three waits of the second only
      expect(reads - before).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a turn that is pending here and the draft, and reads once for notices that come together', async () => {
    const gate = deferred<ApiResult<AssistantTurnAnswer>>();
    const reads: number[] = [];
    const h = harness(async () => gate.promise, 1000, async () => {
      reads.push(reads.length);
      return ok(thread(1));
    });
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    await typeAndSend('who?');
    const other = window2();
    await act(async () => {
      other.announceThreadChanged();
      other.announceThreadChanged();
      other.announceThreadChanged();
    });
    await waitFor(() => expect(reads.length).toBeGreaterThan(1));
    expect(reads.length).toBeLessThanOrEqual(3);
    expect(screen.getByText('who?')).toBeTruthy();
    await act(async () => gate.resolve(ok(REFUSE)));
    expect(await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeTruthy();
  });

  it('keeps a draft that is being typed when the thread is read again', async () => {
    const h = harness(async () => ok(REFUSE), 1000, async () => ok(thread(1)));
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    await userEvent.type(screen.getByLabelText(ASSISTANT_COPY.fieldLabel), 'draft');
    const other = window2();
    await act(async () => other.announceThreadChanged());
    await waitFor(() => expect(h.reads.length).toBeGreaterThan(1));
    expect((screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement).value).toBe('draft');
  });

  it('tells the other windows when a turn settles, and not while it is pending', async () => {
    const gate = deferred<ApiResult<AssistantTurnAnswer>>();
    const h = harness(async () => gate.promise);
    render(h.tree());
    await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
    const other = window2();
    const heard = vi.fn();
    other.onThreadChanged(heard);
    await typeAndSend('who?');
    expect(heard).not.toHaveBeenCalled();
    await act(async () => gate.resolve(ok(REFUSE)));
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
  });

  it('tells the other windows when the chat is cleared', async () => {
    const h = harness(async () => ok(REFUSE), 1000, async () => ok(thread(1)));
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    const other = window2();
    const heard = vi.fn();
    other.onThreadChanged(heard);
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    await userEvent.click((await screen.findAllByRole('button', { name: ASSISTANT_COPY.clearChat })).at(-1) as HTMLElement);
    await waitFor(() => expect(heard).toHaveBeenCalled());
  });
});

describe('the line after a blocked window', () => {
  it('gives a link that opens the chat in this window, where there is a router', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const h = harness(async () => ok(REFUSE));
    render(<MemoryRouter>{h.tree()}</MemoryRouter>);
    await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.popOut }));
    const link = screen.getByRole('link', { name: ASSISTANT_COPY.popOutOpenHere });
    expect(link.getAttribute('href')).toBe('/assistant/inv-1');
  });
});
