import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { InvestigationListItem } from '@neburyx/contracts';
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

function setup(client = pagedClient(rowsOf(3)).client) {
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
    const recorded = pagedClient(rows);
    setup(recorded.client);
    const dialog = await open();
    const options = await within(dialog).findAllByRole('option');
    expect(recorded.recorded.pages[0]).toEqual({ status: 'open', limit: 25 });
    expect(options.map((option) => option.textContent)).toEqual(['Case 1Source source-a', 'Case 2REF-2026-1048 · Source source-b', 'Case 3Source source-a']);
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
    const good = pagedClient(rowsOf(2)).client;
    const client = fakeClient({
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
  });

  it('draws no row for an investigation that is not open, though the response carries one', async () => {
    const rows: InvestigationListItem[] = rowsOf(3, (index) => (index === 1 ? { status: 'closed' as const } : {}));
    const held = pagedClient(rows).client;
    const client = fakeClient({
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
