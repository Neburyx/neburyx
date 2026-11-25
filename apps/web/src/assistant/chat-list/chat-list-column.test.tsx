import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantThreadListResponse } from '@neburyx/contracts';
import type { ApiResult } from '../../api/client.js';
import { fakeClient } from '../../api/fake-client.js';
import { ApiClientProvider } from '../../api/client-context.js';
import { createClientState } from '../../state/client-state.js';
import { ClientStateProvider } from '../../state/context.js';
import { RECORD } from '../assistant-kit.js';
import { AssistantSessionProvider, createAssistantSession } from '../assistant-session.js';
import { REMOVED_CHIP, REPOINTED_CHIP } from '../../lifecycle/copy.js';
import { ChatListColumn } from './chat-list-column.js';
import { CHAT_LIST_COPY } from './copy.js';

afterEach(cleanup);

type Row = AssistantThreadListResponse['items'][number];
type Query = { readonly limit?: number; readonly cursor?: string; readonly q?: string };
const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const NOW = new Date('2026-11-23T12:00:00Z');
const idOf = (n: number): string => `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const chat = (n: number, over: Partial<Row> = {}): Row => ({ investigationId: idOf(n), title: `Chat title ${n}`, caseRef: null, sourceId: 'demo', sourceAlias: 'demo', sourceState: 'available', lastQuestionAt: '2026-11-23T09:00:00.000Z', turns: 1, lastQuestion: `Question ${n}`, lastQuestionCut: false, ...over });
const page = (items: readonly Row[], nextCursor: string | null = null): ApiResult<AssistantThreadListResponse> => ok({ items: [...items], nextCursor });

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function setup(list: (query: Query, signal: AbortSignal | undefined) => Promise<ApiResult<AssistantThreadListResponse>>, options: { shown?: string; record?: typeof RECORD & { sourceState?: 'removed' | 'repointed' | 'available' }; empty?: boolean; onNewChat?: () => void } = {}) {
  const asked: Query[] = [];
  const client = fakeClient({
    listAssistantThreads: async (query, signal) => {
      asked.push(query);
      return list(query, signal);
    },
  });
  const state = createClientState();
  state.bindSource('demo');
  if (options.shown !== undefined) state.show({ id: options.shown, sourceId: 'demo', record: options.record ?? RECORD, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
  const session = createAssistantSession(null);
  if (options.empty === true) session.stored.setState({ kind: 'ready', thread: { turns: [], earlierTurns: 0, previousThreadClearedAt: null } });
  render(
    <MemoryRouter initialEntries={['/assistant']}>
      <ApiClientProvider client={client}>
        <ClientStateProvider state={state}>
          <AssistantSessionProvider value={session}>
            <Routes>
              <Route path="*" element={<ChatListColumn now={() => NOW} onNewChat={options.onNewChat} />} />
            </Routes>
            <Where />
          </AssistantSessionProvider>
        </ClientStateProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { asked, session, state };
}

type Session = ReturnType<typeof createAssistantSession>;
/** A turn this page sent: pending, then settled. */
async function answerATurn(session: Session): Promise<void> {
  await act(async () => session.store.setState({ ...session.store.getState(), turns: [{ id: 1, message: 'x', outcome: { kind: 'pending', call: 'message' } }] }));
  await act(async () => session.store.setState({ ...session.store.getState(), turns: [{ id: 1, message: 'x', outcome: { kind: 'cancelled' } }] }));
}

const rowsShown = (): string[] => screen.queryAllByRole('link').map((link) => link.textContent ?? '');

describe('the chat list column', () => {
  it('lists the chats under their groups, each with the title and the last question, selects the one shown and ends with the footnote', async () => {
    setup(async () => page([chat(1), chat(2, { lastQuestionAt: '2026-11-20T09:00:00.000Z' }), chat(3, { lastQuestionAt: '2026-10-01T09:00:00.000Z' })]), { shown: idOf(2) });
    const groups = await screen.findAllByRole('list');
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Today', 'Previous 7 days', 'Older']);
    expect(within(groups[0] as HTMLElement).getByText('Chat title 1')).toBeTruthy();
    expect(within(groups[1] as HTMLElement).getByText('Question 2')).toBeTruthy();
    const current = screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'true');
    expect(current.map((link) => link.textContent)).toEqual(['Chat title 2Question 2']);
    expect(screen.getByText(CHAT_LIST_COPY.note)).toBeTruthy();
  });

  it('opens the thread of a chat through its route by a click and by Enter, and by no other path', async () => {
    setup(async () => page([chat(1), chat(2)]));
    await userEvent.click(await screen.findByRole('link', { name: /Chat title 2/ }));
    expect(screen.getByTestId('where').textContent).toBe(`/assistant/${idOf(2)}`);
    const first = screen.getByRole('link', { name: /Chat title 1/ });
    first.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('where').textContent).toBe(`/assistant/${idOf(1)}`);
  });

  it('draws the pill of the investigations list on a chat whose source was removed or re-pointed, and on no other', async () => {
    setup(async () => page([chat(1), chat(2, { sourceState: 'removed' }), chat(3, { sourceState: 'repointed' })]));
    await screen.findByText('Chat title 1');
    expect(screen.getAllByText(REMOVED_CHIP)).toHaveLength(1);
    expect(screen.getAllByText(REPOINTED_CHIP)).toHaveLength(1);
    expect(within(screen.getByRole('link', { name: /Chat title 1/ })).queryByText(REMOVED_CHIP)).toBeNull();
    expect(within(screen.getByRole('link', { name: /Chat title 2/ })).getByText(REMOVED_CHIP)).toBeTruthy();
  });

  it('says there are no questions yet for a chat with no turn, and leaves the second line empty for a chat whose turns kept no question', async () => {
    setup(async () => page([chat(1, { turns: 0, lastQuestion: null }), chat(2, { turns: 3, lastQuestion: null })]));
    await screen.findByText(CHAT_LIST_COPY.noQuestions);
    expect(screen.getAllByText(CHAT_LIST_COPY.noQuestions)).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Chat title 2/ }).querySelector('.chat-list-row-question')?.textContent).toBe('');
  });

  it('shows a loading line while the list is read, and does not block the rest of the page', async () => {
    let finish: (value: ApiResult<AssistantThreadListResponse>) => void = () => undefined;
    setup(() => new Promise((resolve) => (finish = resolve)));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', CHAT_LIST_COPY.loading);
    expect((screen.getByRole('button', { name: CHAT_LIST_COPY.newChat }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(page([chat(1)])));
    await screen.findByText('Chat title 1');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the failure with a retry, keeps the rows already shown, and reads again on the retry', async () => {
    let fail = false;
    setup(async () => (fail ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : page([chat(1)])));
    await screen.findByText('Chat title 1');
    fail = true;
    await act(async () => void window.dispatchEvent(new Event('focus')));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Chat title 1')).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: CHAT_LIST_COPY.retryLabel }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText('Chat title 1')).toBeTruthy();
  });

  it('shows the failure when the first read fails, and the empty line for a person with no chat, each with the footnote', async () => {
    setup(async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(CHAT_LIST_COPY.note)).toBeTruthy();
    cleanup();
    setup(async () => page([]));
    expect(await screen.findByText(CHAT_LIST_COPY.empty)).toBeTruthy();
    expect(screen.getByText(CHAT_LIST_COPY.note)).toBeTruthy();
  });

  it('draws New chat, disabled with no handler and calling the handler when there is one', async () => {
    let called = 0;
    setup(async () => page([]), { onNewChat: () => void (called += 1) });
    await userEvent.click(await screen.findByRole('button', { name: CHAT_LIST_COPY.newChat }));
    expect(called).toBe(1);
  });

  it('reaches the search field and then the rows by Tab, and moves between rows by the arrow keys', async () => {
    setup(async () => page([chat(1), chat(2), chat(3)]));
    await screen.findByText('Chat title 1');
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /Chat title 1/ }));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /Chat title 2/ }));
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /Chat title 3/ }));
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /Chat title 2/ }));
  });
});

describe('the chat list column when there are more chats than one page', () => {
  it('reads the next page by Show more until there is none, with no group heading repeated and no chat twice', async () => {
    setup(async (query) => (query.cursor === undefined ? page([chat(1), chat(2)], 'c1') : query.cursor === 'c1' ? page([chat(2), chat(3, { lastQuestionAt: '2026-11-23T08:00:00.000Z' })], 'c2') : page([chat(4, { lastQuestionAt: '2026-10-01T08:00:00.000Z' })])));
    await userEvent.click(await screen.findByRole('button', { name: CHAT_LIST_COPY.showMore }));
    await userEvent.click(await screen.findByRole('button', { name: CHAT_LIST_COPY.showMore }));
    await screen.findByText('Chat title 4');
    expect(rowsShown().map((text) => text.slice(0, 12))).toEqual(['Chat title 1', 'Chat title 2', 'Chat title 3', 'Chat title 4']);
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Today', 'Older']);
    expect(screen.queryByRole('button', { name: CHAT_LIST_COPY.showMore })).toBeNull();
  });

  it('never draws an empty or short page that has a cursor as no chat, and says more may exist', async () => {
    setup(async (query) => (query.cursor === undefined ? page([], 'c1') : page([chat(1)])));
    expect(await screen.findByText(CHAT_LIST_COPY.moreMayExist)).toBeTruthy();
    expect(screen.queryByText(CHAT_LIST_COPY.empty)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: CHAT_LIST_COPY.showMore }));
    await screen.findByText('Chat title 1');
    expect(screen.queryByText(CHAT_LIST_COPY.moreMayExist)).toBeNull();
  });

  it('keeps the rows and offers the same button again when loading more fails, and finishes when it is pressed again', async () => {
    let fail = true;
    setup(async (query) => (query.cursor === undefined ? page([chat(1)], 'c1') : fail ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : page([chat(2)])));
    await userEvent.click(await screen.findByRole('button', { name: CHAT_LIST_COPY.showMore }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Chat title 1')).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: CHAT_LIST_COPY.showMore }));
    await screen.findByText('Chat title 2');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('starts again from the first page, keeping the rows on screen, when the server no longer accepts the cursor', async () => {
    let first = 0;
    const { asked } = setup(async (query) => {
      if (query.cursor === undefined) {
        first += 1;
        return page([chat(first === 1 ? 1 : 9)], 'c1');
      }
      return { ok: false, failure: { code: 'CURSOR_INVALIDATED', message: 'x', retryable: false, traceId: 't' } };
    });
    await userEvent.click(await screen.findByRole('button', { name: CHAT_LIST_COPY.showMore }));
    await screen.findByText('Chat title 9');
    expect(screen.queryByText('Chat title 1')).toBeNull();
    expect(asked.map((query) => query.cursor)).toEqual([undefined, 'c1', undefined]);
  });
});

describe('the chat list column when the window is shown again', () => {
  it('keeps the chats that were loaded by Show more when it reads the list again on focus', async () => {
    const { asked } = setup(async (query) => (query.cursor === undefined ? page([chat(1), chat(2)], 'c1') : page([chat(3)])));
    await userEvent.click(await screen.findByRole('button', { name: CHAT_LIST_COPY.showMore }));
    await screen.findByText('Chat title 3');
    const before = asked.length;
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(asked.length).toBe(before + 2));
    expect(rowsShown().map((text) => text.slice(0, 12))).toEqual(['Chat title 1', 'Chat title 2', 'Chat title 3']);
    expect(screen.queryByRole('button', { name: CHAT_LIST_COPY.showMore })).toBeNull();
  });

  it('reads the list once when the window is made visible and focused together', async () => {
    const { asked } = setup(async () => page([chat(1)]));
    await screen.findByText('Chat title 1');
    const before = asked.length;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(asked.length).toBe(before + 1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(asked.length).toBe(before + 1);
  });

  it('shows the chats it could read when a later page of the reread fails, and leaves the rest to Show more', async () => {
    let fail = false;
    setup(async (query) => (query.cursor === undefined ? page([chat(1), chat(2)], 'c1') : fail ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : page([chat(3)])));
    await userEvent.click(await screen.findByRole('button', { name: CHAT_LIST_COPY.showMore }));
    await screen.findByText('Chat title 3');
    fail = true;
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(rowsShown()).toHaveLength(2));
    expect(screen.getByRole('button', { name: CHAT_LIST_COPY.showMore })).toBeTruthy();
  });
});

describe('the search box of the chat list', () => {
  it('reads the list with the text after the pause once it has two characters, and the whole list again below two', async () => {
    const { asked } = setup(async (query) => page(query.q === 'ab' ? [chat(2)] : [chat(1), chat(2)]));
    await screen.findByText('Chat title 1');
    await userEvent.type(screen.getByRole('searchbox'), 'a');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(asked.some((query) => query.q !== undefined)).toBe(false);
    await userEvent.type(screen.getByRole('searchbox'), 'b');
    await waitFor(() => expect(rowsShown()).toHaveLength(1));
    expect(asked.at(-1)).toEqual({ q: 'ab' });
    await userEvent.type(screen.getByRole('searchbox'), '{Backspace}');
    await waitFor(() => expect(rowsShown()).toHaveLength(2));
    expect(asked.at(-1)).toEqual({});
  });

  it('says no chat matches for a search that matches nothing, and shows the list again when the field is cleared', async () => {
    setup(async (query) => page(query.q === undefined ? [chat(1)] : []));
    await screen.findByText('Chat title 1');
    await userEvent.type(screen.getByRole('searchbox'), 'zz');
    expect(await screen.findByText(CHAT_LIST_COPY.noMatch)).toBeTruthy();
    await userEvent.clear(screen.getByRole('searchbox'));
    await screen.findByText('Chat title 1');
    expect(screen.queryByText(CHAT_LIST_COPY.noMatch)).toBeNull();
  });

  it('drops the answer of an earlier text that arrives after the text was changed, and keeps the rows when a search fails', async () => {
    const waiting: Record<string, (value: ApiResult<AssistantThreadListResponse>) => void> = {};
    setup((query) => (query.q === undefined ? Promise.resolve(page([chat(1)])) : new Promise((resolve) => (waiting[query.q ?? ''] = resolve))));
    await screen.findByText('Chat title 1');
    await userEvent.type(screen.getByRole('searchbox'), 'aa');
    await waitFor(() => expect(waiting['aa']).toBeDefined());
    await userEvent.type(screen.getByRole('searchbox'), 'a');
    await waitFor(() => expect(waiting['aaa']).toBeDefined());
    await act(async () => waiting['aaa']?.({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    await act(async () => waiting['aa']?.(page([chat(7)])));
    expect(screen.queryByText('Chat title 7')).toBeNull();
    expect(screen.getByText('Chat title 1')).toBeTruthy();
  });

  it('clears the field by Escape, keeps the shown chat selected while searching, and says more may exist for a short page with a cursor', async () => {
    const { state } = setup(async (query) => (query.q === undefined ? page([chat(1)]) : page([], 'c9')), { shown: idOf(1) });
    await screen.findByText('Chat title 1');
    await userEvent.type(screen.getByRole('searchbox'), 'xy');
    expect(await screen.findByText(CHAT_LIST_COPY.moreMayExist)).toBeTruthy();
    expect(screen.queryByText(CHAT_LIST_COPY.noMatch)).toBeNull();
    expect(state.investigation.getState().id).toBe(idOf(1));
    await userEvent.keyboard('{Escape}');
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
    await screen.findByText('Chat title 1');
  });
});

describe('the chat list column follows the thread', () => {
  it('reads the list again when a turn of the thread is answered, and moves the chat to the top with the new question', async () => {
    let question = 'First question';
    const { session } = setup(async () => page([chat(1, { lastQuestion: question })]));
    await screen.findByText('First question');
    question = 'Second question';
    await answerATurn(session);
    await screen.findByText('Second question');
  });

  it('reads again until the chat shows the new question when the server stores the turn a moment after it answered', async () => {
    let reads = 0;
    const { session } = setup(
      async () => {
        reads += 1;
        // the first read after the answer still finds the old turn, as when the server commits the turn after it has answered
        return page([reads >= 3 ? chat(1, { turns: 2, lastQuestion: 'Second question' }) : chat(1, { turns: 1, lastQuestion: 'First question' })]);
      },
      { shown: idOf(1) },
    );
    await screen.findByText('First question');
    await answerATurn(session);
    await screen.findByText('Second question', undefined, { timeout: 4000 });
    expect(reads).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(reads).toBe(3);
  });

  it('stops reading again after a few tries when the chat never shows a new turn, and keeps the list', async () => {
    let reads = 0;
    const { session } = setup(
      async () => {
        reads += 1;
        return page([chat(1, { turns: 1, lastQuestion: 'First question' })]);
      },
      { shown: idOf(1) },
    );
    await screen.findByText('First question');
    await answerATurn(session);
    await waitFor(() => expect(reads).toBe(5), { timeout: 8000 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(reads).toBe(5);
    expect(screen.getByText('First question')).toBeTruthy();
  }, 15000);

  it('reads the list again when Clear chat is confirmed, and the chat leaves the column', async () => {
    let rows: Row[] = [chat(1)];
    const { session } = setup(async () => page(rows));
    await screen.findByText('Chat title 1');
    rows = [];
    await act(async () => session.clear({}));
    await screen.findByText(CHAT_LIST_COPY.empty);
    expect(screen.queryByText('Chat title 1')).toBeNull();
  });

  it('reads the list again when the window is shown or regains focus, and keeps the rows when that read fails', async () => {
    let rows: Row[] = [chat(1)];
    let fail = false;
    setup(async () => (fail ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : page(rows)));
    await screen.findByText('Chat title 1');
    rows = [chat(1), chat(2)];
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await screen.findByText('Chat title 2');
    await new Promise((resolve) => setTimeout(resolve, 450));
    fail = true;
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Chat title 2')).toBeTruthy();
  });

  it('does not list a chat whose investigation was closed in another window once the list is read again', async () => {
    let rows: Row[] = [chat(1), chat(2)];
    setup(async () => page(rows));
    await screen.findByText('Chat title 2');
    rows = [chat(1)];
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(screen.queryByText('Chat title 2')).toBeNull());
  });
});

describe('the chat list column: sentences, waiting, focus, lists and the search', () => {
  it('gives each group a named list of its rows, so a screen reader hears the group and the count', async () => {
    setup(async () => page([chat(1), chat(2), chat(3, { lastQuestionAt: '2026-11-20T09:00:00.000Z' })]));
    const lists = await screen.findAllByRole('list', { name: /Today|Previous 7 days/ });
    expect(lists.map((list) => list.getAttribute('aria-label'))).toEqual(['Today', 'Previous 7 days']);
    expect(within(lists[0] as HTMLElement).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('list', { name: 'Previous 7 days' })).toBeTruthy();
  });

  it('says what went wrong in the product sentence, never the code, and offers Try again for a failure that can be tried again', async () => {
    setup(async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The server could not be reached.');
    expect(screen.queryByText(/NETWORK_UNAVAILABLE/)).toBeNull();
    expect(screen.getByRole('button', { name: CHAT_LIST_COPY.retryLabel })).toBeTruthy();
  });

  it('gives up a read that is not answered in time: the failure with Try again, and the late answer is dropped', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let late: (value: ApiResult<AssistantThreadListResponse>) => void = () => undefined;
      let hang = true;
      setup((query, signal) => (hang ? new Promise((resolve) => { late = resolve; signal?.addEventListener('abort', () => undefined); }) : Promise.resolve(page([chat(2)]))));
      expect(screen.getByRole('status').textContent).toBe(CHAT_LIST_COPY.loading);
      await act(async () => void (await vi.advanceTimersByTimeAsync(15_100)));
      expect(screen.getByRole('alert').textContent).toBe('The server could not be reached.');
      await act(async () => late(page([chat(1)])));
      expect(screen.queryByText('Chat title 1')).toBeNull();
      hang = false;
      await act(async () => void screen.getByRole('button', { name: CHAT_LIST_COPY.retryLabel }).click());
      await act(async () => void (await vi.advanceTimersByTimeAsync(50)));
      expect(screen.getByText('Chat title 2')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves the focus to the first new row after Show more, for the keyboard and for the pointer', async () => {
    setup(async (query) => (query.cursor === undefined ? page([chat(1), chat(2)], 'c1') : page([chat(3, { lastQuestionAt: '2026-11-20T09:00:00.000Z' }), chat(4, { lastQuestionAt: '2026-11-19T09:00:00.000Z' })])));
    const button = await screen.findByRole('button', { name: CHAT_LIST_COPY.showMore });
    button.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: /Chat title 3/ })));
  });

  it('moves the focus to the first new row after a click on Show more too', async () => {
    setup(async (query) => (query.cursor === undefined ? page([chat(1)], 'c1') : page([chat(2, { lastQuestionAt: '2026-11-20T09:00:00.000Z' })])));
    await userEvent.click(await screen.findByRole('button', { name: CHAT_LIST_COPY.showMore }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('link', { name: /Chat title 2/ })));
  });

  it('keeps the chats that were loaded by Show more when a search is cleared', async () => {
    const { asked } = setup(async (query) => (query.q !== undefined ? page([chat(1)]) : query.cursor === undefined ? page([chat(1), chat(2)], 'c1') : page([chat(3, { lastQuestionAt: '2026-11-20T09:00:00.000Z' })])));
    await userEvent.click(await screen.findByRole('button', { name: CHAT_LIST_COPY.showMore }));
    await screen.findByText('Chat title 3');
    await userEvent.type(screen.getByRole('searchbox'), 'ab');
    await waitFor(() => expect(rowsShown()).toHaveLength(1));
    await userEvent.clear(screen.getByRole('searchbox'));
    await waitFor(() => expect(rowsShown()).toHaveLength(3));
    expect(screen.queryByRole('button', { name: CHAT_LIST_COPY.showMore })).toBeNull();
    expect(asked.some((query) => query.q === undefined && query.cursor === 'c1')).toBe(true);
  });

  it('reads the list again when the pointer enters it a while after the last read, with no window event', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let rows: Row[] = [chat(1)];
      setup(async () => page(rows));
      await screen.findByText('Chat title 1');
      rows = [chat(1), chat(2)];
      await userEvent.hover(screen.getByRole('link', { name: /Chat title 1/ }));
      expect(screen.queryByText('Chat title 2')).toBeNull();
      vi.setSystemTime(Date.now() + 4000);
      await userEvent.unhover(screen.getByRole('link', { name: /Chat title 1/ }));
      await userEvent.hover(screen.getByRole('link', { name: /Chat title 1/ }));
      await screen.findByText('Chat title 2');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the chat list column: no read that nobody asked for', () => {
  it('reads the list once for a chat that is opened with turns already settled in the session', async () => {
    let reads = 0;
    const { session } = setup(async () => (reads += 1, page([chat(1)])), { shown: idOf(1) });
    await screen.findByText('Chat title 1');
    await act(async () => session.store.setState({ ...session.store.getState(), turns: [1, 2, 3].map((id) => ({ id, message: 'x', outcome: { kind: 'cancelled' as const } })) }));
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(reads).toBe(1);
  });

  it('reads no more when the focus moves between rows, and reads again when the focus comes in from outside', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { asked } = setup(async () => page([chat(1), chat(2)]));
      await screen.findByText('Chat title 2');
      vi.setSystemTime(Date.now() + 4000);
      screen.getByRole('link', { name: /Chat title 1/ }).focus();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const afterEntry = asked.length;
      expect(afterEntry).toBe(2);
      vi.setSystemTime(Date.now() + 4000);
      await userEvent.keyboard('{ArrowDown}');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(asked.length).toBe(afterEntry);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not read again by itself while the list is in the failed state, and Try again is the way back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { asked } = setup(async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
      await screen.findByRole('alert');
      const before = asked.length;
      vi.setSystemTime(Date.now() + 4000);
      await userEvent.hover(screen.getByRole('button', { name: CHAT_LIST_COPY.retryLabel }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(asked.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves no focus after a failed Show more and a later read', async () => {
    let failMore = true;
    setup(async (query) => (query.cursor === undefined ? page([chat(1)], 'c1') : failMore ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : page([chat(2, { lastQuestionAt: '2026-11-20T09:00:00.000Z' })])));
    await userEvent.click(await screen.findByRole('button', { name: CHAT_LIST_COPY.showMore }));
    await screen.findByRole('alert');
    failMore = false;
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect((document.activeElement as HTMLElement | null)?.classList.contains('chat-list-row') ?? false).toBe(false);
  });

  it('cannot give up a read after a newer read has started, and drops the older read when a newer one answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let calls = 0;
      setup((query, signal) => (++calls === 1 ? new Promise(() => signal?.addEventListener('abort', () => undefined)) : Promise.resolve(page([chat(1)]))));
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
      await act(async () => void window.dispatchEvent(new Event('focus')));
      await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
      expect(screen.getByText('Chat title 1')).toBeTruthy();
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText('Chat title 1')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not pile up reads over quick successive turns: each new turn replaces the wait, and the reads end when no turn is stored', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let reads = 0;
      const { session } = setup(async () => (reads += 1, page([chat(1, { turns: 1 })])), { shown: idOf(1) });
      await act(async () => void (await vi.advanceTimersByTimeAsync(50)));
      expect(reads).toBe(1);
      const answer = async (id: number): Promise<void> => {
        const turns = session.store.getState().turns;
        await act(async () => session.store.setState({ ...session.store.getState(), turns: [...turns, { id, message: 'x', outcome: { kind: 'pending', call: 'message' } }] }));
        await act(async () => session.store.setState({ ...session.store.getState(), turns: [...turns, { id, message: 'x', outcome: { kind: 'cancelled' } }] }));
      };
      await answer(1);
      await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
      await answer(2);
      await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
      // one initial read, one for each turn, then one chain of three retries: the chain of the first turn was replaced, not added to
      for (let second = 0; second < 8; second += 1) await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
      expect(reads).toBe(1 + 2 + 3);
      for (let second = 0; second < 8; second += 1) await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
      expect(reads).toBe(6);
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the chat list column: a question that was cut', () => {
  it('ends the second line with an ellipsis when the server cut the stored question, and with none when it did not', async () => {
    setup(async () => page([chat(1, { lastQuestion: 'whether any o', lastQuestionCut: true }), chat(2, { lastQuestion: 'whole question', lastQuestionCut: false })]));
    await screen.findByText('Chat title 1');
    expect(screen.getByRole('link', { name: /Chat title 1/ }).querySelector('.chat-list-row-question')?.textContent).toBe('whether any o…');
    expect(screen.getByRole('link', { name: /Chat title 2/ }).querySelector('.chat-list-row-question')?.textContent).toBe('whole question');
  });
});

describe('the chat list column: the investigation shown with no chat yet', () => {
  const current = (): HTMLElement | null => screen.queryAllByRole('listitem').find((item) => item.textContent?.includes('No questions yet') && item.querySelector('a') === null) ?? null;

  it('draws it as the current row under Today, not a link, and says no chats yet no more', async () => {
    setup(async () => page([]), { shown: idOf(1), empty: true });
    await waitFor(() => expect(current()).not.toBeNull());
    expect(current()?.textContent).toContain('Suspicious linked accounts');
    expect(current()?.querySelector('[aria-current="true"]')).not.toBeNull();
    expect(screen.getByRole('list', { name: 'Today' })).toBeTruthy();
    expect(screen.queryByText(CHAT_LIST_COPY.empty)).toBeNull();
  });

  it('draws it above the other chats of today, and never twice once the list has its real row', async () => {
    let rows: Row[] = [chat(2)];
    const { session } = setup(async () => page(rows), { shown: idOf(1), empty: true });
    await waitFor(() => expect(current()).not.toBeNull());
    expect(screen.getAllByRole('listitem').map((item) => item.textContent?.slice(0, 20))[0]).toContain('Suspicious linked ac');
    rows = [chat(1, { title: 'Suspicious linked accounts' }), chat(2)];
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(current()).toBeNull());
    expect(screen.getAllByText('Suspicious linked accounts')).toHaveLength(1);
    expect(session).toBeTruthy();
  });

  it('is matched by the search only when its title matches', async () => {
    setup(async () => page([]), { shown: idOf(1), empty: true });
    await waitFor(() => expect(current()).not.toBeNull());
    await userEvent.type(screen.getByRole('searchbox'), 'zz');
    await screen.findByText(CHAT_LIST_COPY.noMatch);
    expect(current()).toBeNull();
    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.type(screen.getByRole('searchbox'), 'linked');
    await waitFor(() => expect(current()).not.toBeNull());
  });

  it('is not drawn for a closed investigation, a source that was removed or re-pointed, a chat that has turns, or a list not read yet', async () => {
    cleanup();
    setup(async () => page([]), { shown: idOf(1), empty: true, record: { ...RECORD, status: 'closed' as never } });
    await screen.findByText(CHAT_LIST_COPY.empty);
    expect(current()).toBeNull();
    cleanup();
    setup(async () => page([]), { shown: idOf(1), empty: true, record: { ...RECORD, sourceState: 'removed' } });
    await screen.findByText(CHAT_LIST_COPY.empty);
    expect(current()).toBeNull();
    cleanup();
    setup(async () => page([]), { shown: idOf(1), empty: true, record: { ...RECORD, sourceState: 'repointed' } });
    await screen.findByText(CHAT_LIST_COPY.empty);
    expect(current()).toBeNull();
    cleanup();
    const { session } = setup(async () => page([chat(2)]), { shown: idOf(1) });
    await act(async () => session.stored.setState({ kind: 'ready', thread: { turns: [{ id: idOf(9), seq: 1, at: '2026-11-23T09:00:00.000Z', route: 'view', outcome: 'answered', citedElements: 0, steps: 0 }], earlierTurns: 0, previousThreadClearedAt: null } }));
    await screen.findByText('Chat title 2');
    expect(current()).toBeNull();
  });

  it('stays while the first question is out, and goes when the list has the real row', async () => {
    let rows: Row[] = [];
    const { session } = setup(async () => page(rows), { shown: idOf(1), empty: true });
    await waitFor(() => expect(current()).not.toBeNull());
    await act(async () => session.store.setState({ ...session.store.getState(), turns: [{ id: 1, message: 'x', outcome: { kind: 'pending', call: 'message' } }] }));
    expect(current()).not.toBeNull();
  });

  it('draws none for a chat that already has turns, even while a question of this window is out, and does not carry the row over when the person switches to such a chat', async () => {
    const { session, state } = setup(async () => page([chat(2)]), { shown: idOf(1), empty: true });
    await waitFor(() => expect(current()).not.toBeNull());
    state.show({ id: idOf(3), sourceId: 'demo', record: RECORD, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);
    await act(async () => session.stored.setState({ kind: 'ready', thread: { turns: [{ id: idOf(9), seq: 1, at: '2026-11-23T09:00:00.000Z', route: 'view', outcome: 'answered', citedElements: 0, steps: 0 }], earlierTurns: 0, previousThreadClearedAt: null } }));
    await act(async () => session.store.setState({ ...session.store.getState(), turns: [{ id: 1, message: 'x', outcome: { kind: 'pending', call: 'message' } }] }));
    await screen.findByText('Chat title 2');
    expect(current()).toBeNull();
  });
});
