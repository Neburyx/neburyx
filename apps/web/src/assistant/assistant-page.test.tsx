import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantThreadResponse, AssistantTurnAnswer, AssistantTurnRequest } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf } from '../investigations/test-data.js';
import { NOT_FOUND_TITLE } from '../investigations/messages.js';
import { createClientState } from '../state/client-state.js';
import { aiStatus, renderApp } from '../test-utils.js';
import { ASSISTANT_COPY } from './copy.js';
import { bindAssistantPanel } from './assistant-binder.js';
import { createAssistantSession } from './assistant-session.js';
import { REFUSE } from './assistant-kit.js';
import { createPanelRegistryFor } from '../workspace/panel-registry.js';

const unbinds: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const unbind of unbinds.splice(0)) unbind();
});

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1'), node: nodeOf('source-b', 'kind-a', 'C-1') };
const EMPTY: AssistantThreadResponse = { turns: [], earlierTurns: 0, previousThreadClearedAt: null };

interface Options {
  readonly assistant?: number | undefined;
  readonly turn?: (request: AssistantTurnRequest) => Promise<ApiResult<AssistantTurnAnswer>>;
  readonly thread?: () => Promise<ApiResult<AssistantThreadResponse>>;
}

function setup(path: string, options: Options & { readonly known?: (typeof A)[] } = {}) {
  const known = options.known ?? [A, B];
  const sent: AssistantTurnRequest[] = [];
  const threads: string[] = [];
  const { client, calls } = knowing(known, {
    getAiStatus: async () => ({ ok: true, value: aiStatus({ assistant: 'assistant' in options ? options.assistant : 800 }) }),
    assistantTurn: async (request) => {
      sent.push(request);
      return (options.turn ?? (async () => ({ ok: true as const, value: REFUSE })))(request);
    },
    assistantThread: async (investigationId) => {
      threads.push(investigationId);
      return (options.thread ?? (async () => ({ ok: true as const, value: EMPTY })))();
    },
  });
  const state = createClientState();
  const session = createAssistantSession(null);
  const view = renderApp(path, client, state, undefined, undefined, undefined, undefined, undefined, createPanelRegistryFor(state));
  unbinds.push(bindAssistantPanel(state, view.panels, session));
  return { ...view, client, calls, sent, threads, session, state };
}

describe('/assistant/{id}: opening', () => {
  it('reads an investigation that Explore has not opened, as Explore does, and shows its title, source, read-only and case reference, with Open graph', async () => {
    const h = setup(`/assistant/${INVESTIGATION_A}`);
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(h.calls.getInvestigation).toEqual([INVESTIGATION_A]);
    expect(h.calls.getEntity).toHaveLength(1);
    const header = screen.getByRole('heading', { level: 1 }).parentElement as HTMLElement;
    expect(header.textContent).toContain('read-only');
    expect(header.textContent).toContain('CASE-1');
    expect(screen.getByRole('link', { name: ASSISTANT_COPY.openGraph }).getAttribute('href')).toBe(`/explore/${INVESTIGATION_A}`);
  });

  it('marks the Assistant entry as the current page and lists it in the sidebar between Investigations and Patterns', async () => {
    const h = setup(`/assistant/${INVESTIGATION_A}`);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    const links = within(screen.getByRole('navigation')).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Home', 'Investigations', 'Assistant', 'Patterns', 'Sources']);
    expect(screen.getByRole('link', { name: 'Assistant' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Assistant' }).getAttribute('href')).toBe(`/assistant/${INVESTIGATION_A}`);
  });

  it('shows the not-found message of Explore for an identifier that is not the person’s, with no thread and no composer', async () => {
    const h = setup('/assistant/not-mine');
    expect(await screen.findByRole('heading', { name: NOT_FOUND_TITLE })).toBeTruthy();
    expect(screen.queryByLabelText(ASSISTANT_COPY.fieldLabel)).toBeNull();
  });

  it('shows the failure with a retry and no composer when the investigation cannot be read, then opens on the retry', async () => {
    let fail = true;
    const base = knowing([A]).client;
    const { client } = knowing([A], { getInvestigation: async (id, signal) => (fail ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : base.getInvestigation(id, signal)) });
    const state = createClientState();
    const view = renderApp(`/assistant/${INVESTIGATION_A}`, client, state);
    unbinds.push(bindAssistantPanel(state, view.panels, createAssistantSession(null)));
    expect(await screen.findByRole('group', { name: 'Opening failed' })).toBeTruthy();
    expect(screen.queryByLabelText(ASSISTANT_COPY.fieldLabel)).toBeNull();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    view.unmount();
  });

  it('says that an investigation must be opened first at /assistant when none is held, with a link to Investigations', async () => {
    const h = setup('/assistant');
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.pageNeedsInvestigationTitle })).toBeTruthy();
    expect(screen.getByRole('link', { name: ASSISTANT_COPY.toInvestigations }).getAttribute('href')).toBe('/investigations');
    expect(screen.queryByLabelText(ASSISTANT_COPY.fieldLabel)).toBeNull();
  });
});

describe('/assistant/{id}: asking', () => {
  it('sends a typed message as the one request that carries a question, with the investigation, the source, the masking switch and the shown keys, and shows the bubble and the answer', async () => {
    const h = setup(`/assistant/${INVESTIGATION_A}`);
    const field = await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
    await userEvent.type(field, 'who is linked?{Enter}');
    await screen.findByText('who is linked?');
    expect(await screen.findByText(REFUSE.status === 'answered' && 'sentence' in REFUSE ? REFUSE.sentence : '')).toBeTruthy();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ sourceId: 'source-a', message: 'who is linked?' });
    expect((h.sent[0] as { viewElementKeys?: readonly string[] }).viewElementKeys).toHaveLength(1);
  });

  it('keeps one thread for the page and the panel: the question sent on the page is the session’s thread', async () => {
    const h = setup(`/assistant/${INVESTIGATION_A}`);
    await userEvent.type(await screen.findByLabelText(ASSISTANT_COPY.fieldLabel), 'one thread{Enter}');
    await screen.findByText('one thread');
    expect(h.session.store.getState().turns.map((turn) => turn.message)).toEqual(['one thread']);
  });

  it('refuses an empty message and a message over the limit with nothing sent', async () => {
    const h = setup(`/assistant/${INVESTIGATION_A}`, { assistant: 3 });
    const field = await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
    await userEvent.type(field, '   {Enter}');
    await userEvent.type(field, 'a b c d{Enter}');
    expect(h.sent).toEqual([]);
    expect(screen.getByText('4 / 3 words')).toBeTruthy();
  });

  it('shows the not-available message and a disabled composer when the Assistant is unavailable', async () => {
    const h = setup(`/assistant/${INVESTIGATION_A}`, { assistant: undefined });
    expect(await screen.findByText(ASSISTANT_COPY.unavailableTitle)).toBeTruthy();
    expect((screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement).disabled).toBe(true);
  });
});

describe('/assistant/{id}: the empty thread', () => {
  it('names the investigation, the suggestions, and the model with the numbers shown, and sends a suggestion as the question', async () => {
    const h = setup(`/assistant/${INVESTIGATION_A}`);
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.pageEmptyTitle('kind-a A-1'), level: 2 })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Model: claude-sonnet-5-5 · 1 entity · 0 relationships on the canvas/)).toBeTruthy());
    const press = screen.getByRole('button', { name: 'What is connected to kind-a A-1?' });
    await userEvent.click(press);
    await waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({ message: 'What is connected to kind-a A-1?' });
    await waitFor(() => expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.pageEmptyTitle('kind-a A-1'), level: 2 })).toBeNull());
  });

  it('shows no empty thread when the history holds a stored turn', async () => {
    const stored: AssistantThreadResponse = { turns: [{ id: '0192f000-0000-7000-8000-000000000001', seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'refuse', outcome: 'refused', cause: 'verdict', citedElements: 0, steps: 0, question: 'earlier question' }], earlierTurns: 0, previousThreadClearedAt: null };
    const h = setup(`/assistant/${INVESTIGATION_A}`, { thread: async () => ({ ok: true, value: stored }) });
    await screen.findByText('earlier question');
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.pageEmptyTitle('kind-a A-1'), level: 2 })).toBeNull();
  });

  it('shows the loading note and not the empty thread while the history is read, and the failure note with a usable composer when the read fails', async () => {
    let release: (value: ApiResult<AssistantThreadResponse>) => void = () => undefined;
    const h = setup(`/assistant/${INVESTIGATION_A}`, { thread: () => new Promise((resolve) => (release = resolve)) });
    expect(await screen.findByText(ASSISTANT_COPY.storedLoading)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.pageEmptyTitle('kind-a A-1'), level: 2 })).toBeNull();
    await act(async () => release({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    expect(await screen.findByText(new RegExp(ASSISTANT_COPY.storedFailed))).toBeTruthy();
    expect((screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement).disabled).toBe(false);
  });
});

describe('/assistant/{id}: when the empty thread shows', () => {
  const heading = () => screen.queryByRole('heading', { name: ASSISTANT_COPY.pageEmptyTitle('kind-a A-1'), level: 2 });

  it('shows it with the new-thread card when the history was cleared earlier and holds no turns', async () => {
    setup(`/assistant/${INVESTIGATION_A}`, { thread: async () => ({ ok: true, value: { ...EMPTY, previousThreadClearedAt: '2026-11-18T12:00:00.000Z' } }) });
    expect(await screen.findByText(ASSISTANT_COPY.newThreadTitle)).toBeTruthy();
    expect(heading()).toBeTruthy();
  });

  it('does not show it as a new chat while the status of the AI features is not yet read', async () => {
    const { client } = knowing([A], { getAiStatus: () => new Promise(() => undefined), assistantThread: async () => ({ ok: true, value: EMPTY }) });
    const state = createClientState();
    const view = renderApp(`/assistant/${INVESTIGATION_A}`, client, state, undefined, undefined, undefined, undefined, undefined, createPanelRegistryFor(state));
    unbinds.push(bindAssistantPanel(state, view.panels, createAssistantSession(null)));
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(heading()).toBeNull();
  });

  it('shows the access-lost note and no empty thread when the history read says the investigation is no longer the person’s', async () => {
    setup(`/assistant/${INVESTIGATION_A}`, { thread: async () => ({ ok: false, failure: { code: 'NOT_FOUND', message: 'no', retryable: false, traceId: 'tr-1' } }) });
    expect(await screen.findByText(ASSISTANT_COPY.accessLost)).toBeTruthy();
    expect(heading()).toBeNull();
  });
});

describe('/assistant/{id}: suggestions', () => {
  it('keeps what the person has typed when a suggestion is pressed, and sends the suggestion', async () => {
    const h = setup(`/assistant/${INVESTIGATION_A}`);
    const field = await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
    await userEvent.type(field, 'half a thought');
    await userEvent.click(await screen.findByRole('button', { name: 'Summarize what is on screen' }));
    await waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({ message: 'Summarize what is on screen' });
    expect((screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement).value).toBe('half a thought');
  });

  it('cuts a title over 60 characters on the button, keeps the full title in its tooltip and name, and sends the full title', async () => {
    const long = 'a very long title '.repeat(6).trim();
    const entry = { ...A, investigation: { ...A.investigation, title: long }, node: { ...A.node, display: { ...A.node.display, title: long } } };
    const h = setup(`/assistant/${INVESTIGATION_A}`, { known: [entry, B] });
    const full = `What is connected to ${long}?`;
    const button = await screen.findByRole('button', { name: full });
    expect(button.textContent?.endsWith('…?')).toBe(true);
    expect(button.getAttribute('title')).toBe(full);
    await userEvent.click(button);
    await waitFor(() => expect(h.sent[0]).toMatchObject({ message: full }));
  });
});
