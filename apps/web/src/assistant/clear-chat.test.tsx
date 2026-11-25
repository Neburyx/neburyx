import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantThreadClearResponse, AssistantThreadResponse, AssistantTurnAnswer } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { harness, REFUSE, typeAndSend, type ClearCall } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const storedTurn = (id: string): AssistantThreadResponse['turns'][number] => ({ id, seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'ask', outcome: 'answered', intent: 'shared-devices', citedElements: 3, steps: 1 });
const STORED: AssistantThreadResponse = { turns: [storedTurn('0192f000-0000-7000-8000-0000000000aa')], earlierTurns: 0, previousThreadClearedAt: null };
const EMPTY: AssistantThreadResponse = { turns: [], earlierTurns: 0, previousThreadClearedAt: null };
const failure = (): ApiResult<AssistantThreadClearResponse> => ({ ok: false, failure: { code: 'INTERNAL_ERROR', message: 'no', retryable: false, traceId: 'tr-1' } });
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};
const button = () => screen.queryByRole('button', { name: ASSISTANT_COPY.clearChat });
const dialog = () => screen.queryByRole('dialog');
const openDialog = (): HTMLElement => screen.getByRole('dialog');
const scrim = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('.clear-chat-scrim');
  if (found === null) throw new Error('the scrim is not on the page');
  return found;
};
const open = async () => userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.clearChat }));

async function withStoredThread(clear?: ClearCall) {
  const h = harness(async () => ok(REFUSE), 1000, async () => ok(STORED), false, undefined, clear);
  render(h.tree());
  await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
  return h;
}

describe('the Clear chat button', () => {
  it('is not in the header of a panel with no stored turn and no live turn, and appears with a stored turn', async () => {
    const empty = harness(async () => ok(REFUSE));
    render(empty.tree());
    await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
    expect(button()).toBeNull();
    cleanup();
    await withStoredThread();
    expect(button()).not.toBeNull();
  });

  it('appears with a live turn, just before Close, and is disabled while a turn is pending', async () => {
    const gate = deferred<ApiResult<AssistantTurnAnswer>>();
    const h = harness(async () => gate.promise);
    render(h.tree());
    await typeAndSend('who?');
    const header = screen.getByRole('banner');
    const names = [...header.querySelectorAll('button')].map((entry) => entry.getAttribute('aria-label'));
    expect(names.slice(0, 3)).toEqual([ASSISTANT_COPY.popOut, ASSISTANT_COPY.clearChat, ASSISTANT_COPY.close]);
    expect(button()).toHaveProperty('disabled', true);
    await act(async () => gate.resolve(ok(REFUSE)));
    await waitFor(() => expect(button()).toHaveProperty('disabled', false));
  });
});

describe('the names of the header icon buttons', () => {
  it('are also each button\'s tip, so the header says them the same way (Pop out shows its own two-line tooltip)', async () => {
    await withStoredThread();
    const header = screen.getByRole('banner');
    const buttons = [...header.querySelectorAll('button')].filter((entry) => entry.getAttribute('aria-label') !== ASSISTANT_COPY.popOut);
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const entry of buttons) expect([entry.getAttribute('data-tip'), entry.getAttribute('aria-label')]).toEqual([entry.getAttribute('aria-label'), entry.getAttribute('aria-label')]);
    expect(buttons.map((entry) => entry.getAttribute('data-tip'))).toEqual(expect.arrayContaining([ASSISTANT_COPY.clearChat, ASSISTANT_COPY.close]));
  });
});

describe('the confirmation of Clear chat', () => {
  it('opens as the frame draws it, with focus on Cancel and no call sent', async () => {
    const h = await withStoredThread();
    await open();
    const shown = openDialog();
    expect(shown.getAttribute('aria-modal')).toBe('true');
    expect(shown.textContent).toContain(ASSISTANT_COPY.clearTitle);
    expect(shown.textContent).toContain('This deletes the questions and answers of this thread. The graph, notes and views are unchanged.');
    expect(shown.textContent).toContain('This cannot be undone.');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBe(document.activeElement);
    expect(h.clears).toEqual([]);
  });

  it.each([
    ['Cancel', async () => userEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
    ['Esc', async () => userEvent.keyboard('{Escape}')],
    ['the scrim', async () => userEvent.click(scrim())],
  ])('closes on %s before confirming, returns focus to the button, sends nothing and leaves the thread as it was', async (_name, dismiss) => {
    const h = await withStoredThread();
    await open();
    await dismiss();
    expect(dialog()).toBeNull();
    await waitFor(() => expect(button()).toBe(document.activeElement));
    expect(h.clears).toEqual([]);
    expect(screen.getByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeTruthy();
  });

  it('sends one call with the investigation, shows a busy state in which nothing dismisses it, and sends no second call', async () => {
    const gate = deferred<ApiResult<AssistantThreadClearResponse>>();
    const h = await withStoredThread(async () => gate.promise);
    await open();
    await userEvent.click(within(openDialog()).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    expect(h.clears).toEqual(['inv-1']);
    const shown = openDialog();
    expect(within(shown).getByRole('button', { name: ASSISTANT_COPY.clearing }).hasAttribute('disabled')).toBe(true);
    expect(within(shown).getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(scrim());
    await userEvent.click(within(shown).getByRole('button', { name: ASSISTANT_COPY.clearing }));
    expect(dialog()).not.toBeNull();
    expect(h.clears).toEqual(['inv-1']);
    await act(async () => gate.resolve(ok({ cleared: true })));
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it('shows the empty thread with the suggestions, no button, focus on the composer and a status line when it succeeds', async () => {
    const h = await withStoredThread();
    await open();
    await userEvent.click(within(openDialog()).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(screen.getByText(ASSISTANT_COPY.introTitle)).toBeTruthy();
    expect(screen.getByText('“Summarize what is on screen”')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeNull();
    expect(button()).toBeNull();
    expect(screen.getByLabelText(ASSISTANT_COPY.fieldLabel)).toBe(document.activeElement);
    expect(screen.getByRole('status', { hidden: true }).textContent).toBe(ASSISTANT_COPY.cleared);
    expect(screen.queryByText(ASSISTANT_COPY.newThreadTitle)).toBeNull();
    expect(h.clears).toEqual(['inv-1']);
  });

  it('also clears the live turns of the session', async () => {
    const h = harness(async () => ok(REFUSE));
    render(h.tree());
    await typeAndSend('who?');
    await waitFor(() => expect(h.session.store.getState().turns[0]?.outcome.kind).not.toBe('pending'));
    await open();
    await userEvent.click(within(openDialog()).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(h.session.store.getState().turns).toEqual([]);
    expect(screen.getByText(ASSISTANT_COPY.introTitle)).toBeTruthy();
  });

  it('stays open with a fixed line when the server refuses the call, changes nothing on screen, and can be confirmed again', async () => {
    let calls = 0;
    const h = await withStoredThread(async () => (++calls === 1 ? failure() : ok({ cleared: true })));
    await open();
    await userEvent.click(within(openDialog()).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    expect(within(openDialog()).getByText(ASSISTANT_COPY.clearRefused)).toBeTruthy();
    expect(within(openDialog()).getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('heading', { name: ASSISTANT_COPY.storedHeading, hidden: true })).toBeTruthy();
    await userEvent.click(within(openDialog()).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(h.clears).toEqual(['inv-1', 'inv-1']);
  });

  it('says it could not be confirmed on a network failure', async () => {
    await withStoredThread(async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE', message: 'x', retryable: true, traceId: 'tr' } }));
    await open();
    await userEvent.click(within(openDialog()).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    expect(await within(openDialog()).findByText(ASSISTANT_COPY.clearFailed)).toBeTruthy();
  });

  it('keeps a read of the thread that began before the clearing and arrives after it from bringing the turns back', async () => {
    const late = deferred<ApiResult<AssistantThreadResponse>>();
    let reads = 0;
    const h = harness(async () => ok(REFUSE), 1000, async () => (++reads === 1 ? ok({ ...STORED, epoch: 0 }) : late.promise));
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(reads).toBe(2));
    await open();
    await userEvent.click(within(openDialog()).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    await waitFor(() => expect(dialog()).toBeNull());
    await act(async () => late.resolve(ok({ ...STORED, epoch: 5 })));
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeNull();
    expect(h.session.stored.getState()).toEqual({ kind: 'ready', thread: EMPTY });
  });

  it.each([
    ['the person changed', { principalId: 'another-person' }],
    ['the investigation changed', { investigationId: 'inv-2' }],
  ])('does not touch the thread now on screen when the clearing completes after %s', async (_name, change) => {
    const gate = deferred<ApiResult<AssistantThreadClearResponse>>();
    const other: AssistantThreadResponse = { ...STORED, turns: [storedTurn('0192f000-0000-7000-8000-0000000000bb')] };
    let server = STORED;
    const h = harness(async () => ok(REFUSE), 1000, async () => ok(server), false, undefined, async () => gate.promise);
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    await open();
    await userEvent.click(within(openDialog()).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    server = other;
    act(() => h.session.clear(change));
    await waitFor(() => expect(h.session.stored.getState()).toEqual({ kind: 'ready', thread: other }));
    await act(async () => gate.resolve(ok({ cleared: true })));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(h.session.stored.getState()).toEqual({ kind: 'ready', thread: other });
    expect(h.session.store.getState().epoch).toBeGreaterThan(0);
  });

  it('says a lost response could not be confirmed, keeps the thread on screen, and lets the same clearing be asked again and finish', async () => {
    let calls = 0;
    const h = await withStoredThread(async () => (++calls === 1 ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE', message: 'x', retryable: true, traceId: 't' } } : ok({ cleared: false })));
    await open();
    await userEvent.click(within(openDialog()).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    const shown = await within(openDialog()).findByText(ASSISTANT_COPY.clearFailed);
    expect(shown.textContent).toMatch(/could not be confirmed/);
    expect(shown.textContent).not.toMatch(/nothing was deleted/i);
    expect(screen.getByRole('heading', { name: ASSISTANT_COPY.storedHeading, hidden: true })).toBeTruthy();
    await userEvent.click(within(openDialog()).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(h.clears).toEqual(['inv-1', 'inv-1']);
    expect(screen.getByText(ASSISTANT_COPY.introTitle)).toBeTruthy();
  });
  it.each(['NETWORK_UNAVAILABLE', 'UNREADABLE_RESPONSE', 'SCHEMA_MISMATCH', 'ABORTED', 'UNEXPECTED_FAILURE'] as const)('does not say nothing was deleted when the outcome is not known (%s)', async (code) => {
    await withStoredThread(async () => ({ ok: false, failure: { code } }));
    await open();
    await userEvent.click(within(openDialog()).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    const shown = await within(openDialog()).findByText(ASSISTANT_COPY.clearFailed);
    expect(shown.textContent).not.toMatch(/nothing was deleted/i);
  });

  it.each([['INTERNAL_ERROR', 'Something went wrong. Quote the trace ID if you contact support.'], ['NOT_FOUND', 'Not found.'], ['RATE_LIMITED', 'Too many requests. Try again shortly.']] as const)('says nothing was deleted when the server answers with %s, keeps the thread on screen, and lets the clearing be asked again', async (code, message) => {
    let calls = 0;
    const h = await withStoredThread(async () => (++calls === 1 ? { ok: false, failure: { code, message, retryable: false, traceId: 't' } } : ok({ cleared: true })));
    await open();
    await userEvent.click(within(openDialog()).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    const shown = await within(openDialog()).findByText(ASSISTANT_COPY.clearRefused);
    expect(shown.textContent).toBe('The chat could not be cleared. Nothing was deleted. Try again.');
    expect(screen.getByRole('heading', { name: ASSISTANT_COPY.storedHeading, hidden: true })).toBeTruthy();
    await userEvent.click(within(openDialog()).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(h.clears).toEqual(['inv-1', 'inv-1']);
  });
});
