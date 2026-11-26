import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantThreadListResponse } from '@neburyx/contracts';
import { ApiClientProvider } from '../../api/client-context.js';
import type { ApiResult } from '../../api/client.js';
import { fakeClient } from '../../api/fake-client.js';
import { READ_WAIT_MS } from '../../api/read-wait.js';
import { createClientState } from '../../state/client-state.js';
import { ClientStateProvider } from '../../state/context.js';
import { AssistantSessionProvider, createAssistantSession } from '../assistant-session.js';
import { ChatListColumn } from './chat-list-column.js';
import { CHAT_LIST_COPY } from './copy.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const wait = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const hang = () => new Promise<never>(() => undefined);
const UNREACHABLE = 'The server could not be reached.';
const chat = (n: number): AssistantThreadListResponse['items'][number] => ({ investigationId: `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`, title: `Chat title ${n}`, caseRef: null, sourceId: 'demo', sourceAlias: 'demo', sourceState: 'available', lastQuestionAt: new Date().toISOString(), turns: 1, lastQuestion: `Question ${n}`, lastQuestionCut: false });
const page = (items: readonly number[], nextCursor: string | null = null): ApiResult<AssistantThreadListResponse> => ({ ok: true, value: { items: items.map(chat), nextCursor } });

/** The column over a list whose first Show more gets no answer. */
async function column() {
  const asked: (string | undefined)[] = [];
  let mores = 0;
  const client = fakeClient({
    listAssistantThreads: async (query) => {
      asked.push(query.cursor);
      if (query.cursor === undefined) return page([1], 'c1');
      mores += 1;
      return mores === 1 ? hang() : page([2]);
    },
  });
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <ClientStateProvider state={createClientState()}>
          <AssistantSessionProvider value={createAssistantSession(null)}>
            <ChatListColumn />
          </AssistantSessionProvider>
        </ClientStateProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  await wait();
  await act(async () => void fireEvent.click(screen.getByRole('button', { name: CHAT_LIST_COPY.showMore })));
  return { asked };
}

const chatColumn = () => screen.getByRole('complementary', { name: CHAT_LIST_COPY.label });

describe('the chat list column: a Show more that gets no answer', () => {
  it('says so at the bound, enables the button again, and a later press reads the page', async () => {
    const { asked } = await column();
    await wait(READ_WAIT_MS - 1);
    expect((screen.getByRole('button', { name: CHAT_LIST_COPY.loadingMore }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    await wait(1);
    expect(screen.getByRole('alert').textContent).toBe(UNREACHABLE);
    const again = screen.getByRole('button', { name: CHAT_LIST_COPY.showMore }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    await act(async () => void fireEvent.click(again));
    await wait();
    // the focus that moves to the new row finds an old list and reads it again, which nothing holds back now
    expect(asked.slice(0, 4)).toEqual([undefined, 'c1', 'c1', undefined]);
    expect(screen.getByText('Chat title 2')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('holds back no reread on pointing at the column once the wait has ended', async () => {
    const { asked } = await column();
    await wait(READ_WAIT_MS - 1);
    await act(async () => void fireEvent.pointerEnter(chatColumn()));
    await wait();
    expect(asked).toEqual([undefined, 'c1']);
    await wait(1);
    await wait(4000);
    await act(async () => void fireEvent.pointerEnter(chatColumn()));
    await wait();
    expect(asked).toEqual([undefined, 'c1', undefined]);
  });
});
