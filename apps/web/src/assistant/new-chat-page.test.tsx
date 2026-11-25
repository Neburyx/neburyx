import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
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
const INVESTIGATION_C = '0192f000-0000-7000-8000-0000000000c1';
const C = { investigation: investigationOf(INVESTIGATION_C, 'source-a', 'kind-a', 'C-2'), node: nodeOf('source-a', 'kind-a', 'C-2') };
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

describe('a pick of an investigation that has no chat, on the Assistant page', () => {
  /** The page over three open investigations, none with a chat; once `asked` is set, the list of chats holds one for the investigation the question was asked in. */
  function setupWithoutChats() {
    const known = [A, B, C];
    const state = { asked: false };
    const { client } = knowing(known, {
      getAiStatus: async () => ({ ok: true, value: aiStatus({ assistant: 800 }) }),
      assistantTurn: async () => {
        state.asked = true;
        return { ok: true as const, value: REFUSE };
      },
      assistantThread: async () => ({ ok: true as const, value: EMPTY }),
      listAssistantThreads: async () => ({
        ok: true as const,
        value: {
          items: state.asked
            ? [{ title: 'kind-a C-2', caseRef: null, sourceId: 'source-a', sourceAlias: 'source-a', sourceState: 'available' as const, investigationId: INVESTIGATION_C, lastQuestionAt: new Date().toISOString(), turns: 1, lastQuestion: 'a question', lastQuestionCut: false }]
            : [],
          nextCursor: null,
        },
      }),
      listInvestigationPage: async () => ({ ok: true as const, value: listOf(known.map((entry) => listItemOf(entry.investigation))) }),
      lookupAssistantChats: async () => ({ ok: true as const, value: { withChat: [] } }),
    } satisfies Partial<ApiClient>);
    const calls: string[] = [];
    const recording = new Proxy(client, {
      get: (target, name) => {
        const value: unknown = Reflect.get(target, name);
        return typeof value === 'function' ? (...args: unknown[]) => (calls.push(String(name)), (value as (...given: unknown[]) => unknown).apply(target, args)) : value;
      },
    });
    const appState = createClientState();
    const session = createAssistantSession(null);
    const view = renderApp(`/assistant/${INVESTIGATION_A}`, recording, appState, undefined, undefined, undefined, undefined, undefined, createPanelRegistryFor(appState));
    unbinds.push(bindAssistantPanel(appState, view.panels, session));
    return { ...view, calls, state };
  }

  const rowsOf = (title: string) => [...document.querySelectorAll('.chat-list-row')].filter((row) => row.textContent?.includes(title));

  it('shows the row of the picked investigation in the column at once, highlighted, with "No questions yet", and writes nothing: every call of the pick is a read', async () => {
    const h = setupWithoutChats();
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    await userEvent.click(screen.getByRole('button', { name: CHAT_LIST_COPY.newChat }));
    const dialog = await screen.findByRole('dialog', { name: NEW_CHAT_COPY.title });
    const row = await within(dialog).findByRole('option', { name: /kind-a C-2/u });
    await waitFor(() => expect(within(row).getByText(NEW_CHAT_COPY.startChat)).toBeTruthy());
    const before = h.calls.length;
    await userEvent.click(row);
    expect(await screen.findByRole('heading', { name: 'kind-a C-2', level: 1 })).toBeTruthy();
    await waitFor(() => expect(rowsOf('kind-a C-2')).toHaveLength(1));
    const [current] = rowsOf('kind-a C-2');
    expect(current?.textContent).toContain(CHAT_LIST_COPY.noQuestions);
    expect(current?.closest('[aria-current="true"]') ?? current?.getAttribute('aria-current')).toBeTruthy();
    expect(current?.tagName).not.toBe('A');
    // the landing reads the list, the lookup and the stored thread of the chosen investigation (a read), and writes nothing
    expect(h.calls.slice(before).filter((name) => ![...READS, 'assistantThread'].includes(name))).toEqual([]);
    expect(h.calls.filter((name) => ['assistantTurn', 'clearAssistantThread', 'saveDraft', 'putPreferences', 'openInvestigation', 'deleteInvestigation'].includes(name))).toEqual([]);
  });

  it('keeps one row for the investigation when its first question is asked: the stored chat takes the place of the current row', async () => {
    const h = setupWithoutChats();
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    await userEvent.click(screen.getByRole('button', { name: CHAT_LIST_COPY.newChat }));
    await userEvent.click(await screen.findByRole('option', { name: /kind-a C-2/u }));
    await screen.findByRole('heading', { name: 'kind-a C-2', level: 1 });
    await waitFor(() => expect(rowsOf('kind-a C-2')).toHaveLength(1));
    await userEvent.type(screen.getByLabelText(ASSISTANT_COPY.fieldLabel), 'a question{Enter}');
    await waitFor(() => expect(h.state.asked).toBe(true));
    await waitFor(() => expect(rowsOf('kind-a C-2').some((row) => row.textContent?.includes('a question'))).toBe(true), { timeout: 4000 });
    expect(rowsOf('kind-a C-2')).toHaveLength(1);
    expect(rowsOf('kind-a C-2')[0]?.textContent).not.toContain(CHAT_LIST_COPY.noQuestions);
    await act(async () => undefined);
  });
});
