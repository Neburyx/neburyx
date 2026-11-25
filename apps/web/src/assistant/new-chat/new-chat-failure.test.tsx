import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../../api/client.js';
import { ApiClientProvider } from '../../api/client-context.js';
import { fakeClient } from '../../api/fake-client.js';
import { pagedClient, rowsOf } from '../../investigations-page/page-fixtures.js';
import { REMOVED_CHIP } from '../../lifecycle/copy.js';
import { READ_WAIT_MS } from '../read-wait.js';
import { NewChatPicker } from './new-chat-picker.js';
import { NEW_CHAT_COPY } from './copy.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

function Host() {
  const button = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={button} type="button" onClick={() => setOpen((held) => !held)}>
        New chat
      </button>
      {open ? <NewChatPicker anchor={button} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

const setup = (client: ReturnType<typeof fakeClient>) =>
  render(
    <MemoryRouter initialEntries={['/assistant']}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route path="*" element={<Host />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );

const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
  return screen.findByRole('dialog', { name: NEW_CHAT_COPY.title });
};

const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const ABORTED = { ok: false as const, failure: { code: 'ABORTED' as const } };
/** A request that gets no answer, and ends with an aborted result when it is aborted, as a real one does. */
const never = (signal?: AbortSignal) => new Promise<typeof ABORTED>((resolve) => signal?.addEventListener('abort', () => resolve(ABORTED)));
const NO_CHATS = async () => ({ ok: true as const, value: { withChat: [] as string[] } });
const NETWORK: ApiResult<never> = { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };

describe('the picker of a new chat: a list read that hangs or fails', () => {
  it('gives up a read of the list that gets no answer in the bound shared with the chat list, and says it in words with Try again', async () => {
    const good = pagedClient(rowsOf(2), [], { lookupAssistantChats: NO_CHATS }).client;
    let reads = 0;
    setup(
      fakeClient({
        lookupAssistantChats: NO_CHATS,
        listInvestigationPage: (query, signal) => {
          reads += 1;
          return reads === 1 ? never(signal) : good.listInvestigationPage(query, signal);
        },
      }),
    );
    const dialog = await open();
    await within(dialog).findByText(NEW_CHAT_COPY.loading);
    await wait(READ_WAIT_MS - 500);
    expect(within(dialog).queryByText(/could not be reached/u)).toBeNull();
    await wait(1000);
    const alert = await within(dialog).findByText(/could not be reached/u);
    expect(alert.textContent).toContain('The server could not be reached.');
    expect(alert.textContent).not.toContain('NETWORK_UNAVAILABLE');
    await userEvent.click(within(dialog).getByRole('button', { name: NEW_CHAT_COPY.tryAgain }));
    expect(await within(dialog).findAllByRole('option')).toHaveLength(2);
    expect(within(dialog).queryByText(/could not be reached/u)).toBeNull();
    expect(document.activeElement).toBe(within(dialog).getByRole('combobox'));
  });

  it('says a failed read of the list in the shared sentence, not as the code of the failure', async () => {
    const good = pagedClient(rowsOf(2), [], { lookupAssistantChats: NO_CHATS }).client;
    let reads = 0;
    setup(
      fakeClient({
        lookupAssistantChats: NO_CHATS,
        listInvestigationPage: async (query, signal) => {
          reads += 1;
          return reads === 1 ? NETWORK : good.listInvestigationPage(query, signal);
        },
      }),
    );
    const dialog = await open();
    const alert = await within(dialog).findByText(/could not be reached/u);
    expect(alert.textContent).toContain('The server could not be reached.');
    expect(alert.textContent).not.toContain('NETWORK_UNAVAILABLE');
    await userEvent.click(within(dialog).getByRole('button', { name: NEW_CHAT_COPY.tryAgain }));
    expect(await within(dialog).findAllByRole('option')).toHaveLength(2);
  });
});

describe('the picker of a new chat: a read of more rows that hangs', () => {
  it('gives up a read of the next page that gets no answer, keeps the rows, says so and reads the page again from Show more', async () => {
    const held = pagedClient(rowsOf(60), [], { lookupAssistantChats: NO_CHATS });
    let hung = true;
    setup(
      fakeClient({
        lookupAssistantChats: NO_CHATS,
        listInvestigationPage: (query, signal) => {
          if (signal?.aborted) return Promise.resolve(ABORTED);
          return query.cursor !== undefined && hung ? never(signal) : held.client.listInvestigationPage(query, signal);
        },
      }),
    );
    const dialog = await open();
    await within(dialog).findAllByRole('option');
    await userEvent.click(within(dialog).getByRole('button', { name: NEW_CHAT_COPY.showMore }));
    await wait(READ_WAIT_MS - 500);
    expect(within(dialog).queryByText(NEW_CHAT_COPY.moreFailed)).toBeNull();
    await wait(1000);
    expect(await within(dialog).findByText(NEW_CHAT_COPY.moreFailed)).toBeTruthy();
    expect(within(dialog).getAllByRole('option')).toHaveLength(25);
    hung = false;
    await userEvent.click(within(dialog).getByRole('button', { name: NEW_CHAT_COPY.showMore }));
    await waitFor(() => expect(within(dialog).getAllByRole('option')).toHaveLength(50));
  });
});

describe('the picker of a new chat: a search read that hangs after a list that loaded', () => {
  it('draws none of the earlier rows, no Show more and no lookup note once the read of the search is given up', async () => {
    const held = pagedClient(rowsOf(60), [], { lookupAssistantChats: NO_CHATS });
    setup(
      fakeClient({
        lookupAssistantChats: NO_CHATS,
        listInvestigationPage: (query, signal) => (query.text === 'ca' ? never(signal) : held.client.listInvestigationPage(query, signal)),
      }),
    );
    const dialog = await open();
    await within(dialog).findAllByRole('option');
    await userEvent.type(within(dialog).getByRole('combobox'), 'ca');
    // the search is read after its pause, and the bound counts from then
    await wait(1000);
    await wait(READ_WAIT_MS - 500);
    await wait(1000);
    expect(await within(dialog).findByText(/could not be reached/u)).toBeTruthy();
    expect(within(dialog).queryAllByRole('option')).toHaveLength(0);
    expect(within(dialog).queryByRole('button', { name: NEW_CHAT_COPY.showMore })).toBeNull();
    expect(within(dialog).queryByText(NEW_CHAT_COPY.lookupFailed)).toBeNull();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('the picker of a new chat: the lookup of the chats that hangs or fails', () => {
  it('gives up a lookup that gets no answer in the same bound, claims nothing for the rows, says so and asks again from Try again', async () => {
    const asked: (readonly string[])[] = [];
    const held = pagedClient(rowsOf(3), [], {
      lookupAssistantChats: (ids) => {
        asked.push(ids);
        return asked.length === 1 ? never() : Promise.resolve({ ok: true as const, value: { withChat: [ids[0] ?? ''] } });
      },
    });
    setup(held.client);
    const dialog = await open();
    const rows = await within(dialog).findAllByRole('option');
    expect(rows).toHaveLength(3);
    await wait(READ_WAIT_MS - 500);
    expect(within(dialog).queryByText(NEW_CHAT_COPY.lookupFailed)).toBeNull();
    expect(within(dialog).queryByText(NEW_CHAT_COPY.hasChat)).toBeNull();
    expect(within(dialog).queryByText(NEW_CHAT_COPY.startChat)).toBeNull();
    await wait(1000);
    expect(await within(dialog).findByText(NEW_CHAT_COPY.lookupFailed)).toBeTruthy();
    expect(within(dialog).queryByText(NEW_CHAT_COPY.hasChat)).toBeNull();
    expect(within(dialog).queryByText(NEW_CHAT_COPY.startChat)).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: NEW_CHAT_COPY.lookupTryAgain }));
    await waitFor(() => expect(within(dialog).getAllByText(NEW_CHAT_COPY.hasChat)).toHaveLength(1));
    expect(within(dialog).queryByText(NEW_CHAT_COPY.lookupFailed)).toBeNull();
    expect(asked).toHaveLength(2);
  });

  it('claims nothing and says so when the lookup fails alone, while the list is drawn and a source that is available can be picked', async () => {
    let calls = 0;
    const held = pagedClient(rowsOf(3), [], {
      lookupAssistantChats: async (ids) => {
        calls += 1;
        return calls === 1 ? NETWORK : { ok: true as const, value: { withChat: ids.slice(0, 1) } };
      },
    });
    setup(held.client);
    const dialog = await open();
    expect(await within(dialog).findAllByRole('option')).toHaveLength(3);
    expect(await within(dialog).findByText(NEW_CHAT_COPY.lookupFailed)).toBeTruthy();
    expect(within(dialog).queryByText(NEW_CHAT_COPY.hasChat)).toBeNull();
    for (const option of within(dialog).getAllByRole('option')) expect(option.getAttribute('aria-disabled')).not.toBe('true');
    await userEvent.click(within(dialog).getByRole('button', { name: NEW_CHAT_COPY.lookupTryAgain }));
    await waitFor(() => expect(within(dialog).getAllByText(NEW_CHAT_COPY.hasChat)).toHaveLength(1));
    expect(within(dialog).queryByText(NEW_CHAT_COPY.lookupFailed)).toBeNull();
  });

  it('keeps a removed source that has no chat unpickable once the lookup has answered that it has none', async () => {
    const removed = rowsOf(2, (index) => (index === 0 ? { sourceState: 'removed' as const } : {}));
    setup(pagedClient(removed, [], { lookupAssistantChats: NO_CHATS }).client);
    const dialog = await open();
    const rows = await within(dialog).findAllByRole('option');
    await waitFor(() => expect(within(dialog).getByText(NEW_CHAT_COPY.startChat)).toBeTruthy());
    const gone = rows.find((row) => row.textContent?.includes('Case 1')) as HTMLElement;
    expect(gone.getAttribute('aria-disabled')).toBe('true');
    expect(within(gone).getByText(REMOVED_CHIP)).toBeTruthy();
    expect(within(gone).queryByText(NEW_CHAT_COPY.startChat)).toBeNull();
    await userEvent.click(gone);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('the picker of a new chat: no room under the button', () => {
  it('goes up over the button when the window leaves less than the least height under it, ends inside the window and keeps the rest of the height for the card', async () => {
    const innerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 });
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this.tagName === 'BUTTON' && this.textContent === 'New chat';
      return { x: 40, y: box ? 418 : 0, left: 40, top: box ? 418 : 0, right: 160, bottom: box ? 450 : 0, width: 120, height: 32, toJSON: () => ({}) } as DOMRect;
    });
    try {
      setup(pagedClient(rowsOf(30), [], { lookupAssistantChats: NO_CHATS }).client);
      const dialog = await open();
      await within(dialog).findAllByRole('option');
      const top = Number.parseFloat(dialog.style.top);
      const maxHeight = Number.parseFloat(dialog.style.maxHeight);
      expect(top).toBeLessThan(418);
      expect(top + maxHeight).toBeLessThanOrEqual(500 - 16);
      expect(maxHeight).toBeGreaterThanOrEqual(300);
    } finally {
      rect.mockRestore();
      if (innerHeight !== undefined) Object.defineProperty(window, 'innerHeight', innerHeight);
    }
  });
});
