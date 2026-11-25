import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantThreadResponse, AssistantTurnRequest } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, listOf, nodeOf } from '../investigations/test-data.js';
import { listItemOf } from '../investigations/test-data.js';
import { createClientState } from '../state/client-state.js';
import { aiStatus, renderApp } from '../test-utils.js';
import { bindAssistantPanel } from './assistant-binder.js';
import { createAssistantSession } from './assistant-session.js';
import { ASSISTANT_COPY } from './copy.js';
import { REFUSE } from './assistant-kit.js';
import { CHAT_LIST_COPY } from './chat-list/copy.js';
import { NEW_CHAT_COPY } from './new-chat/copy.js';
import { createPanelRegistryFor } from '../workspace/panel-registry.js';

const unbinds: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const unbind of unbinds.splice(0)) unbind();
});

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1', { sourceState: 'repointed' }), node: nodeOf('source-b', 'kind-a', 'C-1') };
const EMPTY: AssistantThreadResponse = { turns: [], earlierTurns: 0, previousThreadClearedAt: null };

/** The page with the column of the chats and the picker, over a client that records every request it is asked. */
function setup(withChat: readonly string[]) {
  const requests: string[] = [];
  const threads: string[] = [];
  const sent: AssistantTurnRequest[] = [];
  const known = [A, B];
  const { client } = knowing(known, {
    getAiStatus: async () => ({ ok: true, value: aiStatus({ assistant: 800 }) }),
    assistantTurn: async (request) => {
      requests.push('assistantTurn');
      sent.push(request);
      return { ok: true as const, value: REFUSE };
    },
    assistantThread: async (investigationId) => (requests.push('assistantThread'), threads.push(investigationId), { ok: true as const, value: EMPTY }),
    clearAssistantThread: async () => (requests.push('clearAssistantThread'), { ok: true as const, value: { cleared: true } }),
    listAssistantThreads: async () => (requests.push('listAssistantThreads'), { ok: true as const, value: { items: [], nextCursor: null } }),
    listInvestigationPage: async () => (requests.push('listInvestigationPage'), { ok: true as const, value: listOf(known.map((entry) => listItemOf(entry.investigation))) }),
    lookupAssistantChats: async () => (requests.push('lookupAssistantChats'), { ok: true as const, value: { withChat: [...withChat] } }),
  } satisfies Partial<ApiClient>);
  // every method the page calls is recorded, whether or not the test gives it an answer of its own
  const calls: string[] = [];
  const recording = new Proxy(client, {
    get: (target, name) => {
      const value: unknown = Reflect.get(target, name);
      return typeof value === 'function' ? (...args: unknown[]) => (calls.push(String(name)), (value as (...given: unknown[]) => unknown).apply(target, args)) : value;
    },
  });
  const state = createClientState();
  const session = createAssistantSession(null);
  const view = renderApp(`/assistant/${INVESTIGATION_A}`, recording, state, undefined, undefined, undefined, undefined, undefined, createPanelRegistryFor(state));
  unbinds.push(bindAssistantPanel(state, view.panels, session));
  return { ...view, requests, calls, threads, sent, state };
}

/** What a landing may ask of the application: reads, and nothing else. */
const READS = ['getMe', 'getSources', 'getProfile', 'getAiStatus', 'getPreferences', 'getInvestigation', 'getEntity', 'listAssistantThreads', 'listInvestigationPage', 'lookupAssistantChats', 'listInvestigations'];

describe('the picker of a new chat on the Assistant page', () => {
  it('opens under the New chat button of the column, and a pick of another investigation shows that investigation on the page', async () => {
    const h = setup([]);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    await userEvent.click(screen.getByRole('button', { name: CHAT_LIST_COPY.newChat }));
    const dialog = await screen.findByRole('dialog', { name: NEW_CHAT_COPY.title });
    expect(await within(dialog).findAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('button', { name: CHAT_LIST_COPY.newChat }).getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(within(dialog).getAllByText(NEW_CHAT_COPY.startChat).length).toBeGreaterThan(0));
    expect(h.requests).toContain('lookupAssistantChats');
    await userEvent.click(within(dialog).getByRole('option', { name: /kind-a A-1/u }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(screen.getByRole('button', { name: CHAT_LIST_COPY.newChat })).toBe(document.activeElement);
  });

  it('marks the button as the opener of a dialog, closed, as soon as the page is ready, and again for the column of the next investigation', async () => {
    const h = setup([]);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    const button = screen.getByRole('button', { name: CHAT_LIST_COPY.newChat });
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await h.router.navigate(`/assistant/${INVESTIGATION_B}`);
    await screen.findByText(ASSISTANT_COPY.sourceChanged);
    const next = screen.getByRole('button', { name: CHAT_LIST_COPY.newChat });
    expect(next.getAttribute('aria-haspopup')).toBe('dialog');
    expect(next.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when New chat is pressed again, and when the page goes to another investigation', async () => {
    setup([]);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    const button = screen.getByRole('button', { name: CHAT_LIST_COPY.newChat });
    await userEvent.click(button);
    await screen.findByRole('dialog');
    await userEvent.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('lands on the paused source-changed state for an investigation whose source has changed and that has a chat: no empty-thread heading, description or suggestions, nothing sent, and only reads made', async () => {
    const h = setup([INVESTIGATION_B]);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    await userEvent.click(screen.getByRole('button', { name: CHAT_LIST_COPY.newChat }));
    const dialog = await screen.findByRole('dialog');
    const row = await within(dialog).findByRole('option', { name: /kind-a C-1/u });
    await waitFor(() => expect(row.getAttribute('aria-disabled')).toBeNull());
    expect(within(row).getByText(NEW_CHAT_COPY.hasChat)).toBeTruthy();
    const before = h.calls.length;
    const threadReadsBefore = h.threads.length;
    await userEvent.click(row);
    expect(await screen.findByText(ASSISTANT_COPY.sourceChanged)).toBeTruthy();
    // the landing never reads as an empty or a lost chat
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.pageEmptyTitle('kind-a C-1'), level: 2 })).toBeNull();
    expect(screen.queryByText(ASSISTANT_COPY.pageEmptyBody)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Summarize what is on screen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Is anything useful in the data?' })).toBeNull();
    await userEvent.type(screen.getByLabelText(ASSISTANT_COPY.fieldLabel), 'question{Enter}');
    expect(h.sent).toEqual([]);
    // the visit writes nothing: every call after the pick is a read of the list, and the stored turns of the changed source are not read
    const after = h.calls.slice(before);
    expect(after.filter((name) => !READS.includes(name))).toEqual([]);
    expect(h.threads.slice(threadReadsBefore)).toEqual([]);
    expect(h.calls.filter((name) => ['assistantTurn', 'clearAssistantThread', 'saveDraft', 'putPreferences', 'openInvestigation', 'deleteInvestigation'].includes(name))).toEqual([]);
  });
});
