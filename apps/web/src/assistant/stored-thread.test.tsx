import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantThreadResponse, AssistantTurnAnswer } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { createPanelRegistry } from '../workspace/panel-registry.js';
import { bindAssistantPanel } from './assistant-binder.js';
import { harness, RECORD, REFUSE, typeAndSend, type ThreadCall } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const refused = (code: 'INTERNAL_ERROR' | 'NOT_FOUND'): ApiResult<AssistantThreadResponse> => ({ ok: false, failure: { code, message: 'no', retryable: false, traceId: 'tr-1' } });
const STORED: AssistantThreadResponse = {
  turns: [
    { seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'ask', outcome: 'answered', intent: 'shared-devices', citedElements: 3, steps: 1 },
    { seq: 2, at: '2026-11-18T10:05:00.000Z', route: 'refuse', outcome: 'refused', cause: 'verdict', citedElements: 0, steps: 0 },
    { seq: 3, at: '2026-11-18T10:06:00.000Z', route: 'view', outcome: 'refused', cause: 'not-answered', citedElements: 0, steps: 0 },
  ],
  earlierTurns: 0,
  previousThreadClearedAt: null,
};
const CLEARED: AssistantThreadResponse = { turns: [], earlierTurns: 0, previousThreadClearedAt: '2026-11-18T12:00:00.000Z' };
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

function bound(thread: ThreadCall, limit: number | null = 1000, turn: Parameters<typeof harness>[0] = async () => ok(REFUSE)) {
  const h = harness(turn, limit, thread);
  const stop = bindAssistantPanel(h.state, createPanelRegistry(), h.session);
  return { ...h, stop };
}

describe('the notices of the thread (frame AS9)', () => {
  it('says under the input when the thread is cleared, and nothing says that text is kept', async () => {
    const h = harness(async () => ok(REFUSE));
    render(h.tree());
    expect(await screen.findByText(ASSISTANT_COPY.standing)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/kept|keeps|stored|saved text/i);
  });

  it('shows no standing note when the assistant is not available, where nothing can be sent', async () => {
    const h = harness(async () => ok(REFUSE), null);
    render(h.tree());
    await screen.findByText(ASSISTANT_COPY.unavailableTitle);
    expect(screen.queryByText(ASSISTANT_COPY.standing)).toBeNull();
  });

  it('shows the new-thread card of an investigation closed and reopened, as AS9 draws it, and removes it once a turn is sent', async () => {
    const h = harness(async () => ok(REFUSE), 1000, async () => ok(CLEARED));
    render(h.tree());
    expect(await screen.findByText(ASSISTANT_COPY.newThreadTitle)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.newThreadBody)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.newThreadNote)).toBeTruthy();
    expect(screen.getByRole('region', { name: ASSISTANT_COPY.newThreadTitle })).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.introTitle)).toBeNull();
    await typeAndSend('first');
    await screen.findByText(ASSISTANT_COPY.routeRefuse, { selector: 'p' });
    expect(screen.queryByText(ASSISTANT_COPY.newThreadTitle)).toBeNull();
  });

  it('shows no new-thread card for a person who never had a cleared thread, nor when the read of the thread failed', async () => {
    const none = harness(async () => ok(REFUSE));
    render(none.tree());
    await screen.findByText(ASSISTANT_COPY.introTitle);
    expect(screen.queryByText(ASSISTANT_COPY.newThreadTitle)).toBeNull();
    cleanup();
    const failed = harness(async () => ok(REFUSE), 1000, async () => refused('INTERNAL_ERROR'));
    render(failed.tree());
    expect(await screen.findByText(ASSISTANT_COPY.storedFailed)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.newThreadTitle)).toBeNull();
  });

  it('shows the masking card of AS9 when masking changes, and not the new-thread card with it', async () => {
    const h = bound(async () => ok(CLEARED));
    render(h.tree());
    await typeAndSend('first');
    await screen.findByText(ASSISTANT_COPY.routeRefuse, { selector: 'p' });
    act(() => h.state.setMask(true));
    expect(await screen.findByText(ASSISTANT_COPY.maskingTitle)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.maskingBody)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.maskingNote)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.newThreadTitle)).toBeNull();
    h.stop();
  });
});

describe('the stored thread in the panel', () => {
  it('reads the thread once and shows each stored turn as a row above the live thread, with no text of a question or an answer', async () => {
    const h = harness(async () => ok(REFUSE), 1000, async () => ok(STORED));
    render(h.tree());
    const heading = await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    const rows = within(heading.closest('section') as HTMLElement).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([`${ASSISTANT_COPY.routeAsk}shared-devicesAnswered3 sources`, `${ASSISTANT_COPY.routeRefuse}VerdictRefused0 sources`, `${ASSISTANT_COPY.routeView}Not answeredRefused0 sources`]);
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([`${ASSISTANT_COPY.routeAsk}, Answered`, `${ASSISTANT_COPY.routeRefuse}, Refused`, `${ASSISTANT_COPY.routeView}, Refused`]);
    expect(h.reads).toEqual(['inv-1']);
    expect(screen.queryByText(ASSISTANT_COPY.introTitle)).toBeNull();
    expect(screen.queryByText(ASSISTANT_COPY.newThreadTitle)).toBeNull();
  });

  it('shows a waiting state while the thread is read, an error line when the read fails, and nothing for an empty thread, and a message can be sent in each', async () => {
    const wait = deferred<ApiResult<AssistantThreadResponse>>();
    const loading = harness(async () => ok(REFUSE), 1000, () => wait.promise);
    render(loading.tree());
    expect(await screen.findByText(ASSISTANT_COPY.storedLoading)).toBeTruthy();
    await typeAndSend('while loading');
    expect(await screen.findByText(ASSISTANT_COPY.routeRefuse, { selector: 'p' })).toBeTruthy();
    expect(loading.sent).toHaveLength(1);
    cleanup();
    const failed = harness(async () => ok(REFUSE), 1000, async () => refused('INTERNAL_ERROR'));
    render(failed.tree());
    expect(await screen.findByText(ASSISTANT_COPY.storedFailed)).toBeTruthy();
    await typeAndSend('after failure');
    expect(await screen.findByText(ASSISTANT_COPY.routeRefuse, { selector: 'p' })).toBeTruthy();
    cleanup();
    const empty = harness(async () => ok(REFUSE));
    render(empty.tree());
    expect(await screen.findByText(ASSISTANT_COPY.introTitle)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.storedLoading)).toBeNull();
    expect(screen.queryByText(ASSISTANT_COPY.storedFailed)).toBeNull();
  });

  it('shows the lost-access notice when the read says the investigation is no longer the person’s, and not the read-failure line', async () => {
    const h = harness(async () => ok(REFUSE), 1000, async () => refused('NOT_FOUND'));
    render(h.tree());
    expect(await screen.findByText(ASSISTANT_COPY.accessLost)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.storedFailed)).toBeNull();
  });

  it('reads nothing while the assistant is not available, keeps the composer disabled, and sends nothing', async () => {
    const h = harness(async () => ok(REFUSE), null);
    render(h.tree());
    await screen.findByText(ASSISTANT_COPY.unavailableTitle);
    const field = screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement;
    expect(field.disabled).toBe(true);
    await userEvent.type(field, 'hello{Enter}');
    expect(h.sent).toEqual([]);
    expect(h.reads).toEqual([]);
  });

  it('does not show a stored turn twice when the panel is closed and opened again in the same session, and shows the turns of this session once, below the stored ones', async () => {
    const h = harness(async () => ok(REFUSE), 1000, async () => ok(STORED));
    const { unmount } = render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    unmount();
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    expect(h.reads).toEqual(['inv-1']);
    expect(screen.getAllByRole('listitem', { name: /Read from the source, Answered/ })).toHaveLength(1);
    await typeAndSend('mine');
    await screen.findByText(ASSISTANT_COPY.routeRefuse, { selector: 'p' });
    expect(screen.getAllByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toHaveLength(1);
    expect(screen.getAllByText('mine')).toHaveLength(1);
  });

  it('drops the rows with the live thread when the masking changes, and a response that arrives after the clearing does not bring rows back', async () => {
    const wait = deferred<ApiResult<AssistantThreadResponse>>();
    let calls = 0;
    const h = bound(() => (calls++ === 0 ? wait.promise : Promise.resolve(ok(CLEARED))));
    render(h.tree());
    await screen.findByText(ASSISTANT_COPY.storedLoading);
    act(() => h.state.setMask(true));
    await act(async () => {
      wait.resolve(ok(STORED));
    });
    await screen.findByText(ASSISTANT_COPY.newThreadTitle);
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeNull();
    h.stop();
  });

  it('drops an answer that was in flight while a live turn was sent, so the turn is never shown twice', async () => {
    const wait = deferred<ApiResult<AssistantThreadResponse>>();
    const h = harness(async () => ok(REFUSE), 1000, () => wait.promise);
    render(h.tree());
    await screen.findByText(ASSISTANT_COPY.storedLoading);
    await typeAndSend('sent first');
    await screen.findByText(ASSISTANT_COPY.routeRefuse, { selector: 'p' });
    await act(async () => {
      wait.resolve(ok(STORED));
    });
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeNull();
    expect(screen.getAllByText('sent first')).toHaveLength(1);
  });

  it('drops an answer that was in flight while the investigation was closed and reopened, and reads the thread again for each lifecycle (the close and the reopen)', async () => {
    const first = deferred<ApiResult<AssistantThreadResponse>>();
    let calls = 0;
    const h = bound(() => (calls++ === 0 ? first.promise : Promise.resolve(ok(CLEARED))));
    render(h.tree());
    await screen.findByText(ASSISTANT_COPY.storedLoading);
    const record = h.state.investigation.getState().record;
    if (record === null) throw new Error('the investigation is shown');
    act(() => h.state.describeInvestigation({ ...record, status: 'closed' }));
    act(() => h.state.describeInvestigation({ ...record, status: 'open' }));
    await act(async () => {
      first.resolve(ok(STORED));
    });
    expect(await screen.findByText(ASSISTANT_COPY.newThreadTitle)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeNull();
    expect(h.reads).toEqual(['inv-1', 'inv-1', 'inv-1']);
    h.stop();
  });

  it('makes the rows reachable in order and gives each an accessible name', async () => {
    const h = harness(async () => ok(REFUSE), 1000, async () => ok(STORED));
    render(h.tree());
    const list = (await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading })).closest('section') as HTMLElement;
    expect(within(list).getByRole('list')).toBeTruthy();
    expect(within(list).getAllByRole('listitem').map((row) => row.getAttribute('aria-label'))).toHaveLength(3);
  });

  it('says how many older turns are not shown when the server gave only the newest', async () => {
    const h = harness(async () => ok(REFUSE), 1000, async () => ok({ ...STORED, earlierTurns: 12 }));
    render(h.tree());
    expect(await screen.findByText('12 earlier turns are not shown.')).toBeTruthy();
  });

  it('clears the whole panel when the read says the access is lost while a live turn is pending, ends the reading, and does not read again', async () => {
    const denied = deferred<ApiResult<AssistantThreadResponse>>();
    const answer = deferred<ApiResult<AssistantTurnAnswer>>();
    const flow = bound(() => denied.promise, 1000, () => answer.promise);
    render(flow.tree());
    await screen.findByText(ASSISTANT_COPY.storedLoading);
    await typeAndSend('pending one');
    await act(async () => {
      denied.resolve(refused('NOT_FOUND'));
    });
    expect(await screen.findByText(ASSISTANT_COPY.accessLost)).toBeTruthy();
    expect(screen.queryByText('pending one')).toBeNull();
    await act(async () => {
      answer.resolve(ok(REFUSE));
    });
    expect(screen.queryByText('pending one')).toBeNull();
    expect(screen.queryByText(ASSISTANT_COPY.routeRefuse, { selector: 'p' })).toBeNull();
    expect(flow.reads).toEqual(['inv-1']);
    flow.stop();
  });

  it('ends the reading when the server says the assistant is off although the shell said it was available, treats the assistant as unavailable, and sends nothing', async () => {
    const h = harness(async () => ok(REFUSE), 1000, async () => ({ ok: false, failure: { code: 'ACCESS_DENIED', message: 'off', retryable: false, traceId: 'tr-1', details: { reason: 'ai-off' } } }));
    render(h.tree());
    expect(await screen.findByText(ASSISTANT_COPY.unavailableTitle)).toBeTruthy();
    const field = screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement;
    expect(field.disabled).toBe(true);
    await userEvent.type(field, 'hello{Enter}');
    expect(h.sent).toEqual([]);
    expect(h.reads).toEqual(['inv-1']);
  });

  it('drops stored rows and a read in flight when the source changes with no live turn, and reads nothing while the source stays changed', async () => {
    const wait = deferred<ApiResult<AssistantThreadResponse>>();
    let calls = 0;
    const h = bound(() => (calls++ === 0 ? wait.promise : Promise.resolve(ok(STORED))));
    render(h.tree());
    await screen.findByText(ASSISTANT_COPY.storedLoading);
    act(() => h.state.describeInvestigation({ ...RECORD, sourceState: 'removed' }));
    await act(async () => {
      wait.resolve(ok(STORED));
    });
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeNull();
    expect(h.reads).toEqual(['inv-1']);
    act(() => h.state.describeInvestigation(RECORD));
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeTruthy();
    expect(h.reads).toEqual(['inv-1', 'inv-1']);
    h.stop();
  });

  it('shows stored rows, then drops them when the source changes, and reads again only once it is as it was', async () => {
    const h = bound(async () => ok(STORED));
    render(h.tree());
    await screen.findByRole('heading', { name: ASSISTANT_COPY.storedHeading });
    act(() => h.state.describeInvestigation({ ...RECORD, sourceState: 'removed' }));
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.storedHeading })).toBeNull();
    expect(h.reads).toEqual(['inv-1']);
    h.stop();
  });

  it('blocks Send and the Enter key for a draft that was typed before the server said the assistant is off', async () => {
    const reply = deferred<ApiResult<AssistantThreadResponse>>();
    const h = harness(async () => ok(REFUSE), 1000, () => reply.promise);
    render(h.tree());
    const field = await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
    await userEvent.type(field, 'a draft');
    await act(async () => {
      reply.resolve({ ok: false, failure: { code: 'ACCESS_DENIED', message: 'off', retryable: false, traceId: 'tr-1', details: { reason: 'ai-off' } } });
    });
    await screen.findByText(ASSISTANT_COPY.unavailableTitle);
    const send = screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await act(async () => {
      send.form?.requestSubmit();
    });
    expect(h.sent).toEqual([]);
  });
});
