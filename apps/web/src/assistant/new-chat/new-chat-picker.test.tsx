import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { InvestigationListItem } from '@neburyx/contracts';
import { REMOVED_CHIP, REPOINTED_CHIP } from '../../lifecycle/copy.js';
import type { ApiResult } from '../../api/client.js';
import { ApiClientProvider } from '../../api/client-context.js';
import { fakeClient } from '../../api/fake-client.js';
import { pagedClient, rowsOf } from '../../investigations-page/page-fixtures.js';
import { NewChatPicker } from './new-chat-picker.js';
import { NEW_CHAT_COPY } from './copy.js';

afterEach(cleanup);

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function Host() {
  const button = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={button} type="button" onClick={() => setOpen((held) => !held)}>
        New chat
      </button>
      <p>outside</p>
      {open ? <NewChatPicker anchor={button} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

const NO_CHATS = async () => ({ ok: true as const, value: { withChat: [] } });

function setup(client = pagedClient(rowsOf(3), [], { lookupAssistantChats: NO_CHATS }).client) {
  render(
    <MemoryRouter initialEntries={['/assistant']}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route path="*" element={<Host />} />
        </Routes>
        <Where />
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
  return screen.findByRole('dialog', { name: NEW_CHAT_COPY.title });
};

describe('the picker of a new chat: the list and the pick', () => {
  it('asks for the open investigations, 25 at a time, and draws one row for each with its title and under it the case reference and the source, under the heading, the line and the footer of the frame', async () => {
    const rows = rowsOf(3, (index) => (index === 1 ? { caseRef: 'REF-2026-1048' } : {}));
    const recorded = pagedClient(rows, [], { lookupAssistantChats: NO_CHATS });
    setup(recorded.client);
    const dialog = await open();
    const options = await within(dialog).findAllByRole('option');
    expect(recorded.recorded.pages[0]).toEqual({ status: 'open', limit: 25 });
    expect(options.map((option) => option.querySelector('.new-chat-row-title')?.textContent)).toEqual(['Case 1', 'Case 2', 'Case 3']);
    expect(options.map((option) => option.querySelector('.new-chat-row-detail')?.textContent)).toEqual(['Source source-a', 'REF-2026-1048 · Source source-b', 'Source source-a']);
    expect(within(dialog).getByText(NEW_CHAT_COPY.description)).toBeTruthy();
    expect(within(dialog).getByText(NEW_CHAT_COPY.footer)).toBeTruthy();
  });

  it('closes on a pick, gives the focus back to the button and goes to the chat of the investigation', async () => {
    setup();
    const dialog = await open();
    await userEvent.click(await within(dialog).findByRole('option', { name: /Case 2/u }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'New chat' })).toBe(document.activeElement);
    expect(screen.getByTestId('where').textContent).toBe('/assistant/0192f000-0000-7000-8000-000000000002');
  });

  it('closes on Escape and on a press outside, with no navigation, and gives the focus back to the button on Escape', async () => {
    setup();
    let dialog = await open();
    await within(dialog).findAllByRole('option');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'New chat' })).toBe(document.activeElement);
    dialog = await open();
    await within(dialog).findAllByRole('option');
    await userEvent.click(screen.getByText('outside'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('/assistant');
  });

  it('closes when the button that opened it is pressed again, and a press inside the picker keeps it open', async () => {
    setup();
    const dialog = await open();
    await within(dialog).findAllByRole('option');
    await userEvent.click(within(dialog).getByText(NEW_CHAT_COPY.description));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says it is loading while the first page is read, and shows the failure with a retry when the read fails, navigating nowhere', async () => {
    let answers = 0;
    const failure: ApiResult<never> = { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } };
    const good = pagedClient(rowsOf(2), [], { lookupAssistantChats: NO_CHATS }).client;
    const client = fakeClient({
      lookupAssistantChats: NO_CHATS,
      listInvestigationPage: async (query, signal) => {
        answers += 1;
        if (answers === 1) return failure;
        return good.listInvestigationPage(query, signal);
      },
    });
    setup(client);
    const dialog = await open();
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/assistant');
    await userEvent.click(within(dialog).getByRole('button', { name: NEW_CHAT_COPY.tryAgain }));
    expect(await within(dialog).findAllByRole('option')).toHaveLength(2);
    expect(document.activeElement).toBe(within(dialog).getByRole('combobox'));
  });

  it('draws no row for an investigation that is not open, though the response carries one', async () => {
    const rows: InvestigationListItem[] = rowsOf(3, (index) => (index === 1 ? { status: 'closed' as const } : {}));
    const held = pagedClient(rows).client;
    const client = fakeClient({
      lookupAssistantChats: NO_CHATS,
      listInvestigationPage: async () => {
        const [opened, closed] = await Promise.all([held.listInvestigationPage({ status: 'open' }), held.listInvestigationPage({ status: 'closed' })]);
        if (!opened.ok || !closed.ok) return opened;
        return { ok: true as const, value: { ...opened.value, items: [...opened.value.items, ...closed.value.items] } };
      },
    });
    setup(client);
    const dialog = await open();
    await waitFor(async () => expect((await within(dialog).findAllByRole('option')).length).toBeGreaterThan(0));
    expect(within(dialog).queryByRole('option', { name: /Case 2/u })).toBeNull();
  });
});

describe('the picker of a new chat: search, paging and the states of the list', () => {
  const rowTitles = (): string[] => screen.queryAllByRole('option').map((option) => option.querySelector('.new-chat-row-title')?.textContent ?? '');

  it('searches after the debounce with the trimmed text of two characters or more, asks for the whole list for fewer, and draws only the newest answer', async () => {
    const held = pagedClient(rowsOf(6), [], { lookupAssistantChats: NO_CHATS });
    const releases: (() => void)[] = [];
    const client = fakeClient({
      lookupAssistantChats: NO_CHATS,
      listInvestigationPage: async (query, signal) => {
        const answer = await held.client.listInvestigationPage(query, signal);
        if (query.text === 'ca') await new Promise<void>((resolve) => releases.push(resolve));
        return answer;
      },
    });
    setup(client);
    const dialog = await open();
    await within(dialog).findAllByRole('option');
    const search = within(dialog).getByRole('combobox', { name: NEW_CHAT_COPY.searchLabel });
    await userEvent.type(search, 'c');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(held.recorded.pages).toHaveLength(1);
    await userEvent.type(search, 'a');
    await waitFor(() => expect(held.recorded.pages.at(-1)).toEqual({ status: 'open', limit: 25, text: 'ca' }));
    await userEvent.type(search, 'se 5  ');
    await waitFor(() => expect(held.recorded.pages.at(-1)).toEqual({ status: 'open', limit: 25, text: 'case 5' }));
    await waitFor(() => expect(rowTitles()).toEqual(['Case 5']));
    await act(async () => releases.forEach((release) => release()));
    expect(rowTitles()).toEqual(['Case 5']);
    await userEvent.clear(search);
    await waitFor(() => expect(held.recorded.pages.at(-1)).toEqual({ status: 'open', limit: 25 }));
  });

  it('says it is loading while a search is read, with no row of the earlier list drawn as its answer', async () => {
    const held = pagedClient(rowsOf(4), [], { lookupAssistantChats: NO_CHATS });
    let hold: (() => void) | undefined;
    const client = fakeClient({
      lookupAssistantChats: NO_CHATS,
      listInvestigationPage: async (query, signal) => {
        const answer = await held.client.listInvestigationPage(query, signal);
        if (query.text === 'zz') await new Promise<void>((resolve) => (hold = resolve));
        return answer;
      },
    });
    setup(client);
    const dialog = await open();
    await within(dialog).findAllByRole('option');
    await userEvent.type(within(dialog).getByRole('combobox'), 'zz');
    expect(await within(dialog).findByText(NEW_CHAT_COPY.loading)).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    await act(async () => hold?.());
    await waitFor(() => expect(within(dialog).queryByText(NEW_CHAT_COPY.loading)).toBeNull());
  });

  it('says there is no open investigation with no search, and that nothing matches for a search', async () => {
    setup(pagedClient([], [], { lookupAssistantChats: NO_CHATS }).client);
    let dialog = await open();
    expect(await within(dialog).findByText(NEW_CHAT_COPY.empty)).toBeTruthy();
    cleanup();
    setup(pagedClient(rowsOf(3), [], { lookupAssistantChats: NO_CHATS }).client);
    dialog = await open();
    await within(dialog).findAllByRole('option');
    await userEvent.type(within(dialog).getByRole('combobox'), 'nothing like it');
    expect(await within(dialog).findByText(NEW_CHAT_COPY.noMatch)).toBeTruthy();
  });

  it('pages by the cursor over eight pages, 25 rows at a time with no cap, with no row twice and the focus on the control that reads more', async () => {
    const held = pagedClient(rowsOf(205), [], { lookupAssistantChats: NO_CHATS });
    setup(held.client);
    const dialog = await open();
    await within(dialog).findAllByRole('option');
    for (let page = 2; page <= 9; page += 1) {
      const more = await within(dialog).findByRole('button', { name: NEW_CHAT_COPY.showMore });
      more.focus();
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(Math.min(205, page * 25)));
      if (page < 9) expect(document.activeElement).toBe(await within(dialog).findByRole('button', { name: NEW_CHAT_COPY.showMore }));
      // the last page takes the control away: the focus is in the search box then, not on the page
      else expect(document.activeElement).toBe(screen.getByRole('combobox', { name: NEW_CHAT_COPY.searchLabel }));
    }
    const titles = rowTitles();
    expect(titles).toHaveLength(205);
    expect(new Set(titles).size).toBe(205);
    expect(within(dialog).queryByRole('button', { name: NEW_CHAT_COPY.showMore })).toBeNull();
    expect(held.recorded.pages.map((page) => page.cursor)).toEqual([undefined, '25', '50', '75', '100', '125', '150', '175', '200']);
  });

  it('keeps the rows and says so when a read of more fails, and reads that page again from the control', async () => {
    const held = pagedClient(rowsOf(60), [], { lookupAssistantChats: NO_CHATS });
    let failNext = true;
    const client = fakeClient({
      listInvestigationPage: async (query, signal) => {
        if (query.cursor !== undefined && failNext) {
          failNext = false;
          return { ok: false as const, failure: { code: 'NETWORK_UNAVAILABLE' as const } };
        }
        return held.client.listInvestigationPage(query, signal);
      },
    });
    setup(client);
    const dialog = await open();
    await within(dialog).findAllByRole('option');
    await userEvent.click(within(dialog).getByRole('button', { name: NEW_CHAT_COPY.showMore }));
    expect(await within(dialog).findByText(NEW_CHAT_COPY.moreFailed)).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(25);
    await userEvent.click(within(dialog).getByRole('button', { name: NEW_CHAT_COPY.showMore }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(50));
  });

  it('starts again from the first page when the server no longer accepts the cursor', async () => {
    const held = pagedClient(rowsOf(60), [], { lookupAssistantChats: NO_CHATS });
    let refused = false;
    const client = fakeClient({
      listInvestigationPage: async (query, signal) => {
        if (query.cursor !== undefined && !refused) {
          refused = true;
          return { ok: false as const, failure: { code: 'CURSOR_INVALIDATED' as const, message: 'x', retryable: false, traceId: 't' } };
        }
        return held.client.listInvestigationPage(query, signal);
      },
    });
    setup(client);
    const dialog = await open();
    await within(dialog).findAllByRole('option');
    await userEvent.click(within(dialog).getByRole('button', { name: NEW_CHAT_COPY.showMore }));
    await waitFor(() => expect(held.recorded.pages.filter((page) => page.cursor === undefined).length).toBe(2));
    expect(within(dialog).queryByText(NEW_CHAT_COPY.moreFailed)).toBeNull();
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(25));
  });
});

describe('the picker of a new chat: the chips and a source that cannot start a chat', () => {
  const ids = (n: number): string => `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const rowsWith = (overrides: (index: number) => Partial<InvestigationListItem>): InvestigationListItem[] => rowsOf(5, overrides);
  /** Rows 1 to 5: 1 has a chat, 2 has a removed source and no chat, 3 has a repointed source and a chat, 4 has a repointed source and no chat, 5 has an available source and no chat. */
  const mixed = rowsWith((index) => (index === 1 ? { sourceState: 'removed' as const } : index === 2 || index === 3 ? { sourceState: 'repointed' as const } : {}));
  const withChat = [ids(1), ids(3)];

  function mixedSetup(lookup: (asked: readonly string[]) => Promise<ApiResult<{ withChat: string[] }>>) {
    const asked: (readonly string[])[] = [];
    const client = pagedClient(mixed, [], {
      lookupAssistantChats: async (idsAsked) => {
        asked.push(idsAsked);
        return lookup(idsAsked);
      },
    }).client;
    setup(client);
    return asked;
  }
  const rowFor = (title: string): HTMLElement => screen.getByRole('option', { name: new RegExp(title, 'u') });

  it('asks the lookup once for the ids drawn, shows "Has a chat" for the rows it names and the chip of a source that is gone, with both for a gone source that has a chat', async () => {
    const asked = mixedSetup(async () => ({ ok: true, value: { withChat } }));
    const dialog = await open();
    await waitFor(() => expect(within(rowFor('Case 1')).getByText(NEW_CHAT_COPY.hasChat)).toBeTruthy());
    expect(asked).toEqual([[ids(1), ids(2), ids(3), ids(4), ids(5)]]);
    expect(within(rowFor('Case 2')).queryByText(NEW_CHAT_COPY.hasChat)).toBeNull();
    expect(within(rowFor('Case 2')).getByText(REMOVED_CHIP)).toBeTruthy();
    expect(within(rowFor('Case 3')).getByText(NEW_CHAT_COPY.hasChat)).toBeTruthy();
    expect(within(rowFor('Case 3')).getByText(REPOINTED_CHIP)).toBeTruthy();
    expect(within(rowFor('Case 4')).getByText(REPOINTED_CHIP)).toBeTruthy();
    expect(within(rowFor('Case 4')).queryByText(NEW_CHAT_COPY.hasChat)).toBeNull();
    expect(within(rowFor('Case 5')).getByText(NEW_CHAT_COPY.startChat)).toBeTruthy();
    expect(within(dialog).getAllByRole('option')).toHaveLength(5);
  });

  it('does not pick a gone source that has no chat, says why to a screen reader, and picks a gone source that has a chat as any other row', async () => {
    mixedSetup(async () => ({ ok: true, value: { withChat } }));
    await open();
    await waitFor(() => expect(within(rowFor('Case 1')).getByText(NEW_CHAT_COPY.hasChat)).toBeTruthy());
    const stuck = rowFor('Case 2');
    expect(stuck.getAttribute('aria-disabled')).toBe('true');
    expect(stuck.getAttribute('aria-describedby')).toBe(within(stuck).getByText(REMOVED_CHIP).id);
    await userEvent.click(stuck);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/assistant');
    await userEvent.click(rowFor('Case 3'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe(`/assistant/${ids(3)}`);
  });

  it('keeps a gone source unpickable and claiming nothing while the lookup has not answered and when it failed, and a source that is available can still be picked', async () => {
    let release: (() => void) | undefined;
    mixedSetup(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } });
        }),
    );
    await open();
    await screen.findAllByRole('option');
    for (const title of ['Case 2', 'Case 3', 'Case 4']) {
      expect(rowFor(title).getAttribute('aria-disabled')).toBe('true');
      expect(within(rowFor(title)).queryByText(NEW_CHAT_COPY.hasChat)).toBeNull();
      expect(within(rowFor(title)).queryByText(NEW_CHAT_COPY.startChat)).toBeNull();
    }
    expect(within(rowFor('Case 5')).queryByText(NEW_CHAT_COPY.hasChat)).toBeNull();
    await act(async () => release?.());
    for (const title of ['Case 2', 'Case 3']) expect(rowFor(title).getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(rowFor('Case 5'));
    expect(screen.getByTestId('where').textContent).toBe(`/assistant/${ids(5)}`);
  });

  it('asks the lookup once for each page that Show more reads, and writes nothing: every request of the picker is a read', async () => {
    const asked: (readonly string[])[] = [];
    const held = pagedClient(rowsOf(60), [], { lookupAssistantChats: async (idsAsked) => (asked.push(idsAsked), { ok: true as const, value: { withChat: [] } }) });
    setup(held.client);
    const dialog = await open();
    await within(dialog).findAllByRole('option');
    await userEvent.click(within(dialog).getByRole('button', { name: NEW_CHAT_COPY.showMore }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(50));
    await userEvent.click(within(dialog).getByRole('button', { name: NEW_CHAT_COPY.showMore }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(60));
    expect(asked.map((page) => page.length)).toEqual([25, 25, 10]);
    expect(new Set(asked.flat()).size).toBe(60);
    expect(held.recorded.views).toEqual([]);
  });
});

describe('the picker of a new chat: the keyboard path and the names a screen reader hears', () => {
  const mixed = rowsOf(5, (index) => (index === 1 ? { sourceState: 'removed' as const } : {}));
  const idOf = (n: number): string => `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const withChat = async () => ({ ok: true as const, value: { withChat: [] as string[] } });
  const field = (): HTMLElement => screen.getByRole('combobox', { name: NEW_CHAT_COPY.searchLabel });
  const activeName = (): string | null => {
    const id = field().getAttribute('aria-activedescendant');
    return id === null ? null : (document.getElementById(id)?.querySelector('.new-chat-row-title')?.textContent ?? null);
  };

  async function openMixed() {
    setup(pagedClient(mixed, [], { lookupAssistantChats: withChat }).client);
    const dialog = await open();
    await within(dialog).findAllByRole('option');
    await waitFor(() => expect(within(screen.getAllByRole('option')[0] as HTMLElement).queryByText(NEW_CHAT_COPY.startChat)).toBeTruthy());
    return dialog;
  }

  it('opens as a labelled dialog with the focus in the search box, and the rows as the options of a listbox the box controls', async () => {
    const dialog = await openMixed();
    expect(document.activeElement).toBe(field());
    expect(dialog.getAttribute('aria-labelledby')).toBe(within(dialog).getByRole('heading', { name: NEW_CHAT_COPY.title }).id);
    expect(field().getAttribute('aria-controls')).toBe(within(dialog).getByRole('listbox', { name: NEW_CHAT_COPY.listLabel }).id);
    expect(field().getAttribute('aria-activedescendant')).toBeNull();
  });

  it('moves the highlight over the rows that can be picked with ArrowDown and ArrowUp, wrapping at the ends and skipping a row whose source is gone', async () => {
    await openMixed();
    await userEvent.keyboard('{ArrowDown}');
    expect(activeName()).toBe('Case 1');
    await userEvent.keyboard('{ArrowDown}');
    expect(activeName()).toBe('Case 3');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(activeName()).toBe('Case 5');
    await userEvent.keyboard('{ArrowDown}');
    expect(activeName()).toBe('Case 1');
    await userEvent.keyboard('{ArrowUp}');
    expect(activeName()).toBe('Case 5');
    expect(within(screen.getAllByRole('option')[4] as HTMLElement).getByText(NEW_CHAT_COPY.startChat)).toBeTruthy();
    expect(screen.getAllByRole('option').filter((option) => option.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(screen.getAllByRole('option')[1]?.getAttribute('aria-disabled')).toBe('true');
  });

  it('takes Home and End to the first and the last row once there is a highlight, and leaves them to the text while there is none', async () => {
    await openMixed();
    await userEvent.type(field(), 'ab');
    await userEvent.keyboard('{Home}');
    expect(activeName()).toBeNull();
    expect((field() as HTMLInputElement).selectionStart).toBe(0);
    await userEvent.keyboard('{ArrowDown}{End}');
    expect(activeName()).toBe('Case 5');
    await userEvent.keyboard('{Home}');
    expect(activeName()).toBe('Case 1');
  });

  it('picks the highlighted row with Enter, picks nothing with no highlight, and closes on Escape with the focus on the button', async () => {
    await openMixed();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/assistant');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe(`/assistant/${idOf(3)}`);
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New chat' }));
  });

  it('keeps the focus inside the picker: Tab goes from the search box to Show more and round again, Shift+Tab the other way', async () => {
    setup(pagedClient(rowsOf(60), [], { lookupAssistantChats: withChat }).client);
    const dialog = await open();
    await within(dialog).findAllByRole('option');
    const more = within(dialog).getByRole('button', { name: NEW_CHAT_COPY.showMore });
    await userEvent.tab();
    expect(document.activeElement).toBe(more);
    await userEvent.tab();
    expect(document.activeElement).toBe(field());
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(more);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('clears the highlight when a search changes the list, and tells a screen reader how many match, from the exact count of the answer', async () => {
    await openMixed();
    await userEvent.keyboard('{ArrowDown}');
    expect(activeName()).toBe('Case 1');
    await waitFor(() => expect(screen.getByRole('status', { name: '' }).textContent).toBe('5 open investigations'));
    await userEvent.type(field(), 'case 5');
    await waitFor(() => expect(activeName()).toBeNull());
    await waitFor(() => expect(screen.getAllByRole('status').map((node) => node.textContent)).toContain('1 match'));
  });
});

describe('the picker of a new chat: a search that is being read, a lookup that fails, the edge of the window', () => {
  it('draws no highlight and picks nothing with the keys while a search is read, though the rows of the earlier list are still held', async () => {
    const held = pagedClient(rowsOf(4), [], { lookupAssistantChats: NO_CHATS });
    let release: (() => void) | undefined;
    const client = fakeClient({
      lookupAssistantChats: NO_CHATS,
      listInvestigationPage: async (query, signal) => {
        const answer = await held.client.listInvestigationPage(query, signal);
        if (query.text === 'ca') await new Promise<void>((resolve) => (release = resolve));
        return answer;
      },
    });
    setup(client);
    const dialog = await open();
    await within(dialog).findAllByRole('option');
    await userEvent.type(within(dialog).getByRole('combobox'), 'ca');
    await within(dialog).findByText(NEW_CHAT_COPY.loading);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(within(dialog).getByRole('combobox').getAttribute('aria-activedescendant')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/assistant');
    await act(async () => release?.());
  });

  it('asks the lookup for at most 100 ids at a time over pages whose first lookups failed, and then knows the chats', async () => {
    const asked: number[] = [];
    let calls = 0;
    const held = pagedClient(rowsOf(130), [], {
      lookupAssistantChats: async (ids) => {
        asked.push(ids.length);
        calls += 1;
        return calls <= 4 ? { ok: false as const, failure: { code: 'NETWORK_UNAVAILABLE' as const } } : { ok: true as const, value: { withChat: [] } };
      },
    });
    setup(held.client);
    const dialog = await open();
    await within(dialog).findAllByRole('option');
    for (let page = 2; page <= 6; page += 1) {
      await userEvent.click(await within(dialog).findByRole('button', { name: NEW_CHAT_COPY.showMore }));
      await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(Math.min(130, page * 25)));
    }
    await waitFor(() => expect(asked.length).toBeGreaterThan(4));
    expect(Math.max(...asked)).toBeLessThanOrEqual(100);
  });

  it('gives the focus back to the button after a press outside on text', async () => {
    setup();
    const dialog = await open();
    await within(dialog).findAllByRole('option');
    await userEvent.click(screen.getByText('outside'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'New chat' })).toBe(document.activeElement));
  });
});

