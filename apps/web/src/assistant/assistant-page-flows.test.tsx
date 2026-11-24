import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantThreadResponse, AssistantTurnAnswer, AssistantTurnRequest } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf } from '../investigations/test-data.js';
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

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1'), node: nodeOf('source-a', 'kind-a', 'A-1') };
const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1'), node: nodeOf('source-b', 'kind-a', 'C-1') };
const EMPTY: AssistantThreadResponse = { turns: [], earlierTurns: 0, previousThreadClearedAt: null };
const STORED: AssistantThreadResponse = { turns: [{ id: '0192f000-0000-7000-8000-000000000001', seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'refuse', outcome: 'refused', cause: 'verdict', citedElements: 0, steps: 0, question: 'earlier question' }], earlierTurns: 0, previousThreadClearedAt: null };
const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const refusedCall: (request: AssistantTurnRequest) => Promise<ApiResult<AssistantTurnAnswer>> = async () => ok(REFUSE);

interface Options {
  readonly turn?: (request: AssistantTurnRequest) => Promise<ApiResult<AssistantTurnAnswer>>;
  readonly thread?: (investigationId: string, mask: boolean) => Promise<ApiResult<AssistantThreadResponse>>;
  readonly clear?: (investigationId: string) => Promise<ApiResult<{ cleared: true }>>;
  readonly known?: typeof A[];
}

function setup(path: string, options: Options = {}) {
  const sent: AssistantTurnRequest[] = [];
  const threads: { investigationId: string; mask: boolean }[] = [];
  const clears: string[] = [];
  const { client } = knowing(options.known ?? [A, B], {
    getAiStatus: async () => ok(aiStatus({ assistant: 800 })),
    assistantTurn: async (request) => {
      sent.push(request);
      return (options.turn ?? refusedCall)(request);
    },
    assistantThread: async (investigationId, mask) => {
      threads.push({ investigationId, mask });
      return (options.thread ?? (async () => ok(EMPTY)))(investigationId, mask);
    },
    clearAssistantThread: async (investigationId) => {
      clears.push(investigationId);
      return (options.clear ?? (async () => ok({ cleared: true as const })))(investigationId);
    },
  });
  const state = createClientState();
  const session = createAssistantSession(null);
  const view = renderApp(path, client, state, undefined, undefined, undefined, undefined, undefined, createPanelRegistryFor(state));
  unbinds.push(bindAssistantPanel(state, view.panels, session));
  return { ...view, sent, threads, clears, session, state };
}

const clearButton = () => screen.queryByRole('button', { name: ASSISTANT_COPY.clearChat });

describe('the Assistant page: Clear chat', () => {
  it('has Clear chat disabled until a thread exists, asks first, and a cancel changes nothing', async () => {
    const h = setup(`/assistant/${INVESTIGATION_A}`);
    await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
    expect((clearButton() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(ASSISTANT_COPY.fieldLabel), 'a question{Enter}');
    await screen.findByText('a question');
    await userEvent.click(clearButton() as HTMLElement);
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /Cancel/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('a question')).toBeTruthy();
    expect(h.clears).toEqual([]);
  });

  it('clears the thread on confirm, calls the clear once and shows the empty thread again', async () => {
    const h = setup(`/assistant/${INVESTIGATION_A}`);
    await userEvent.type(await screen.findByLabelText(ASSISTANT_COPY.fieldLabel), 'a question{Enter}');
    await screen.findByText('a question');
    await userEvent.click(clearButton() as HTMLElement);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    await waitFor(() => expect(screen.queryByText('a question')).toBeNull());
    expect(h.clears).toEqual([INVESTIGATION_A]);
    expect(await screen.findByRole('heading', { name: ASSISTANT_COPY.pageEmptyTitle('kind-a A-1'), level: 2 })).toBeTruthy();
    expect((clearButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the thread and says the clearing could not be confirmed when the clear fails', async () => {
    const h = setup(`/assistant/${INVESTIGATION_A}`, { clear: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    await userEvent.type(await screen.findByLabelText(ASSISTANT_COPY.fieldLabel), 'a question{Enter}');
    await screen.findByText('a question');
    await userEvent.click(clearButton() as HTMLElement);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: ASSISTANT_COPY.clearChat }));
    expect(await screen.findByText(new RegExp(ASSISTANT_COPY.clearFailed.slice(0, 30)))).toBeTruthy();
    expect(screen.getByText('a question')).toBeTruthy();
    expect(h.clears).toHaveLength(1);
  });
});

describe('the Assistant page: the thread follows the investigation, the masking switch and the person', () => {
  it('clears the thread and drops a late answer when another investigation is opened', async () => {
    let finish: (value: ApiResult<AssistantTurnAnswer>) => void = () => undefined;
    const h = setup(`/assistant/${INVESTIGATION_A}`, { turn: () => new Promise((resolve) => (finish = resolve)) });
    await userEvent.type(await screen.findByLabelText(ASSISTANT_COPY.fieldLabel), 'slow question{Enter}');
    await screen.findByText('slow question');
    await act(async () => {
      await h.router.navigate(`/assistant/${INVESTIGATION_B}`);
    });
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    await act(async () => finish(ok(REFUSE)));
    expect(screen.queryByText('slow question')).toBeNull();
    expect(h.session.store.getState().turns).toEqual([]);
  });

  it('clears the shown text with the masking notice when the switch changes, and reads the stored thread again under the new switch', async () => {
    const h = setup(`/assistant/${INVESTIGATION_A}`, { thread: async () => ok(STORED) });
    await screen.findByText('earlier question');
    await userEvent.type(screen.getByLabelText(ASSISTANT_COPY.fieldLabel), 'live question{Enter}');
    await screen.findByText('live question');
    const before = h.threads.length;
    await act(async () => h.state.setMask(true));
    await waitFor(() => expect(screen.queryByText('live question')).toBeNull());
    await waitFor(() => expect(h.threads.length).toBeGreaterThan(before));
    expect(h.threads.at(-1)?.mask).toBe(true);
  });

  it('shows nothing of another person’s thread held by the session', async () => {
    const h = setup('/investigations');
    await screen.findByRole('link', { name: 'Assistant' });
    h.session.store.setState({ ...h.session.store.getState(), investigationId: INVESTIGATION_A, principalId: 'someone-else', nextId: 2, turns: [{ id: 1, message: 'private question of someone else', outcome: { kind: 'pending', call: 'message' } }] });
    await act(async () => {
      await h.router.navigate(`/assistant/${INVESTIGATION_A}`);
    });
    await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
    expect(screen.queryByText('private question of someone else')).toBeNull();
  });

  it('still cancels a pending turn after the person leaves the page and returns to the same investigation', async () => {
    let signal: AbortSignal | undefined;
    let finish: (value: ApiResult<AssistantTurnAnswer>) => void = () => undefined;
    const sent: AssistantTurnRequest[] = [];
    const { client } = knowing([A, B], {
      getAiStatus: async () => ok(aiStatus({ assistant: 800 })),
      assistantThread: async () => ok(EMPTY),
      assistantTurn: (request, abort) => {
        sent.push(request);
        signal = abort;
        return new Promise((resolve) => (finish = resolve));
      },
    });
    const state = createClientState();
    const session = createAssistantSession(null);
    const view = renderApp(`/assistant/${INVESTIGATION_A}`, client, state, undefined, undefined, undefined, undefined, undefined, createPanelRegistryFor(state));
    unbinds.push(bindAssistantPanel(state, view.panels, session));
    await userEvent.type(await screen.findByLabelText(ASSISTANT_COPY.fieldLabel), 'slow question{Enter}');
    await screen.findByText('slow question');
    await act(async () => {
      await view.router.navigate('/investigations');
    });
    await act(async () => {
      await view.router.navigate(`/assistant/${INVESTIGATION_A}`);
    });
    await userEvent.click(await screen.findByRole('button', { name: ASSISTANT_COPY.cancel }));
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(ok(REFUSE)));
    expect(sent).toHaveLength(1);
    expect(screen.queryByText(REFUSE.status === 'answered' && 'sentence' in REFUSE ? REFUSE.sentence : '')).toBeNull();
    expect(session.store.getState().turns[0]?.outcome.kind).toBe('cancelled');
  });
});

describe('the Assistant page: a changed source', () => {
  it('opens the saved layout with the paused message and sends nothing', async () => {
    const changed = { ...A, investigation: { ...A.investigation, sourceState: 'repointed' as const } };
    const h = setup(`/assistant/${INVESTIGATION_A}`, { known: [changed, B] });
    expect(await screen.findByText(ASSISTANT_COPY.sourceChanged)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(ASSISTANT_COPY.fieldLabel), 'question{Enter}');
    expect(h.sent).toEqual([]);
  });
});

describe('the Assistant page and the panel share one thread', () => {
  it('shows on the page the question sent in the panel', async () => {
    const h = setup(`/explore/${INVESTIGATION_A}`);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    await act(async () => h.state.presentation.setAssistantOpen(true));
    await userEvent.type(await screen.findByLabelText(ASSISTANT_COPY.fieldLabel), 'asked in the panel{Enter}');
    await screen.findByText('asked in the panel');
    await act(async () => {
      await h.router.navigate(`/assistant/${INVESTIGATION_A}`);
    });
    expect(await screen.findByText('asked in the panel')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: ASSISTANT_COPY.pageEmptyTitle('kind-a A-1'), level: 2 })).toBeNull();
  });

  it('shows in the panel the question sent on the page', async () => {
    const h = setup(`/assistant/${INVESTIGATION_A}`);
    await userEvent.type(await screen.findByLabelText(ASSISTANT_COPY.fieldLabel), 'asked on the page{Enter}');
    await screen.findByText('asked on the page');
    await act(async () => {
      await h.router.navigate(`/explore/${INVESTIGATION_A}`);
    });
    await act(async () => h.state.presentation.setAssistantOpen(true));
    expect(await screen.findByText('asked on the page')).toBeTruthy();
  });
});

describe('the Assistant page: a failed turn and a clear with a pending turn', () => {
  it('keeps the thread and the typed text after a recoverable failure', async () => {
    const h = setup(`/assistant/${INVESTIGATION_A}`, { turn: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    await userEvent.type(await screen.findByLabelText(ASSISTANT_COPY.fieldLabel), 'will fail{Enter}');
    await screen.findAllByText('will fail');
    expect(await screen.findByRole('button', { name: ASSISTANT_COPY.tryAgain })).toBeTruthy();
    expect(h.session.store.getState().turns).toHaveLength(1);
  });

  it('does not show an answer that arrives after the chat was cleared', async () => {
    let finish: (value: ApiResult<AssistantTurnAnswer>) => void = () => undefined;
    const h = setup(`/assistant/${INVESTIGATION_A}`, { turn: () => new Promise((resolve) => (finish = resolve)) });
    await userEvent.type(await screen.findByLabelText(ASSISTANT_COPY.fieldLabel), 'pending question{Enter}');
    await screen.findByText('pending question');
    await act(async () => h.session.clear({}));
    await act(async () => finish(ok(REFUSE)));
    expect(screen.queryByText('pending question')).toBeNull();
    expect(h.session.store.getState().turns).toEqual([]);
  });

  it('clears the thread when the investigation is closed while the page is open', async () => {
    const h = setup(`/assistant/${INVESTIGATION_A}`);
    await userEvent.type(await screen.findByLabelText(ASSISTANT_COPY.fieldLabel), 'before closing{Enter}');
    await screen.findByText('before closing');
    await act(async () => {
      const held = h.state.investigation.getState();
      if (held.record === null) throw new Error('no record');
      h.state.describeInvestigation({ ...held.record, status: 'closed', readOnly: true });
    });
    await waitFor(() => expect(screen.queryByText('before closing')).toBeNull());
  });
});
