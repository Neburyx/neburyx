import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeClient } from '../../api/fake-client.js';
import { ApiClientProvider } from '../../api/client-context.js';
import { createClientState } from '../../state/client-state.js';
import { ClientStateProvider } from '../../state/context.js';
import { AssistantSessionProvider, createAssistantSession } from '../assistant-session.js';
import { ChatListColumn } from './chat-list-column.js';

const cutNow = vi.hoisted(() => ({ value: true }));
vi.mock('../cut-text.js', () => ({ cuts: () => cutNow.value, textWidthOf: () => 0 }));

afterEach(cleanup);

function setup(question: string, narrow = false) {
  const client = fakeClient({
    listAssistantThreads: async (query) => ({
      ok: true,
      value: { items: query.q !== undefined && narrow ? [] : [{ investigationId: '0192f000-0000-7000-8000-000000000001', title: 'Chat title 1', caseRef: null, sourceId: 'demo', sourceAlias: 'demo', sourceState: 'available', lastQuestionAt: new Date().toISOString(), turns: 1, lastQuestion: question }], nextCursor: null },
    }),
  });
  const state = createClientState();
  state.bindSource('demo');
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <ClientStateProvider state={state}>
          <AssistantSessionProvider value={createAssistantSession(null)}>
            <ChatListColumn />
          </AssistantSessionProvider>
        </ClientStateProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe('the tip of a chat row whose text is cut', () => {
  it('shows the full title and question on hover and on keyboard focus, and Esc takes it away', async () => {
    cutNow.value = true;
    setup('Which accounts does this customer hold?');
    const link = await screen.findByRole('link', { name: /Chat title 1/ });
    await userEvent.hover(link);
    expect(document.querySelector('.assistant-table-tip')?.textContent).toBe('Chat title 1\nWhich accounts does this customer hold?');
    await userEvent.unhover(link);
    expect(document.querySelector('.assistant-table-tip')).toBeNull();
    await act(async () => link.focus());
    expect(document.querySelector('.assistant-table-tip')).not.toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(document.querySelector('.assistant-table-tip')).toBeNull();
  });

  it('shows no tip for a row whose text is not cut', async () => {
    cutNow.value = false;
    setup('Short');
    await userEvent.hover(await screen.findByRole('link', { name: /Chat title 1/ }));
    expect(document.querySelector('.assistant-table-tip')).toBeNull();
  });

  it('takes the tip away when a search leaves the row out of the list', async () => {
    cutNow.value = true;
    setup('Which accounts does this customer hold?', true);
    await userEvent.hover(await screen.findByRole('link', { name: /Chat title 1/ }));
    expect(document.querySelector('.assistant-table-tip')).not.toBeNull();
    await userEvent.type(screen.getByRole('searchbox'), 'zz');
    await screen.findByText('No chats match your search.');
    expect(document.querySelector('.assistant-table-tip')).toBeNull();
  });
});
