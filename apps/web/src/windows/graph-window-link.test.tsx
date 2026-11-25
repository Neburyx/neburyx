import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf } from '../investigations/test-data.js';
import { ASSISTANT_COPY } from '../assistant/copy.js';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { aiStatus, countingClient, renderApp, stubFactory } from '../test-utils.js';
import { createPanelRegistryFor } from '../workspace/panel-registry.js';
import { bindAssistantPanel } from '../assistant/assistant-binder.js';
import { createAssistantSession } from '../assistant/assistant-session.js';
import { REFUSE } from '../assistant/assistant-kit.js';
import type { AssistantTurnRequest } from '@neburyx/contracts';
import { createWindowChannel, type WindowChannel, type WindowScope } from './window-channel.js';
import { CHAT_SELECTION_NOTE, chatSelectionOf } from './chat-selection.js';

class FakeBroadcastChannel {
  static readonly all = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    const set = FakeBroadcastChannel.all.get(name) ?? new Set();
    set.add(this);
    FakeBroadcastChannel.all.set(name, set);
  }
  postMessage(data: unknown): void {
    for (const other of FakeBroadcastChannel.all.get(this.name) ?? []) if (other !== this) other.onmessage?.({ data: structuredClone(data) });
  }
  close(): void {
    FakeBroadcastChannel.all.get(this.name)?.delete(this);
  }
}

const SCOPE: WindowScope = { principalId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', investigationId: INVESTIGATION_A, sourceId: 'source-a' };
const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const KEY = elementKey({ sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' });
const OTHER_KEY = elementKey({ sourceId: 'source-a', entityType: 'kind-a', stableId: 'NOT-LOADED' });
const opened: WindowChannel[] = [];

beforeEach(() => {
  FakeBroadcastChannel.all.clear();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
});
afterEach(() => {
  cleanup();
  for (const channel of opened.splice(0)) channel.close();
  vi.unstubAllGlobals();
});

async function graph(state = createClientState()) {
  const known = knowing([A]);
  const { calls } = known;
  const counted = countingClient(known.client);
  const view = renderApp(`/explore/${INVESTIGATION_A}`, counted.client, state, undefined, stubFactory().create);
  await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
  const sender = createWindowChannel(SCOPE);
  opened.push(sender);
  const answers: { requestId: string; onCanvas: readonly string[] }[] = [];
  sender.onSelectionResult((result) => answers.push(result));
  return { view, state, sender, answers, calls, count: counted.count };
}
const selected = (state: ReturnType<typeof createClientState>): readonly string[] => [...state.presentation.view.getState().selection];

describe('the graph window and a selection made in another window', () => {
  it('announces itself as a graph window, so that another window of the person sees it open', async () => {
    await graph();
    const watcher = createWindowChannel(SCOPE);
    opened.push(watcher);
    await waitFor(() => expect(watcher.others.getState().has('graph')).toBe(true));
  });

  it('selects an element its canvas draws and answers with that key', async () => {
    const h = await graph();
    const calls = structuredClone(h.calls.getInvestigation);
    const before = h.count();
    h.sender.sendSelection([KEY]);
    await waitFor(() => expect(h.answers).toHaveLength(1));
    expect(h.answers[0]?.onCanvas).toEqual([KEY]);
    expect(selected(h.state)).toEqual([KEY]);
    expect(h.calls.getInvestigation).toEqual(calls);
    expect(h.count()).toBe(before);
  });

  it('answers with no key and selects and draws nothing for an element it does not hold', async () => {
    const h = await graph();
    const before = h.count();
    h.sender.sendSelection([OTHER_KEY]);
    await waitFor(() => expect(h.answers).toHaveLength(1));
    expect(h.answers[0]?.onCanvas).toEqual([]);
    expect(selected(h.state)).toEqual([]);
    expect(h.count()).toBe(before);
  });

  it('ignores a selection that holds more than one key: nothing selected and no answer', async () => {
    const h = await graph();
    h.sender.sendSelection([KEY, OTHER_KEY]);
    expect(h.answers).toEqual([]);
    expect(selected(h.state)).toEqual([]);
  });

  it('ignores a selection for another investigation or another source', async () => {
    const h = await graph();
    for (const scope of [{ ...SCOPE, investigationId: 'another' }, { ...SCOPE, sourceId: 'source-b' }]) {
      const elsewhere = createWindowChannel(scope);
      opened.push(elsewhere);
      elsewhere.sendSelection([KEY]);
    }
    expect(h.answers).toEqual([]);
    expect(selected(h.state)).toEqual([]);
  });
});

describe('opening the graph with an element selected', () => {
  it('selects the element once the graph is loaded, takes the key out of the navigation state and never puts it in the address', async () => {
    const { client } = knowing([A]);
    const state = createClientState();
    const view = renderApp({ pathname: `/explore/${INVESTIGATION_A}`, state: { select: KEY } }, client, state, undefined, stubFactory().create);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    await waitFor(() => expect(selected(state)).toEqual([KEY]));
    expect(view.router.state.location.pathname + view.router.state.location.search).toBe(`/explore/${INVESTIGATION_A}`);
    expect(JSON.stringify(view.router.state.location.state ?? null)).not.toContain('A-1');
    expect(screen.queryByText(ASSISTANT_COPY.selectionNotOnCanvas)).toBeNull();
  });

  it('selects nothing and says the element is not on the canvas when it is not loaded after the graph opens', async () => {
    const { client } = knowing([A]);
    const state = createClientState();
    renderApp({ pathname: `/explore/${INVESTIGATION_A}`, state: { select: OTHER_KEY } }, client, state, undefined, stubFactory().create);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(await screen.findByText(ASSISTANT_COPY.selectionNotOnCanvas)).toBeTruthy();
    expect(selected(state)).toEqual([]);
  });
});

describe('the notice of an arrival whose element is not on the canvas', () => {
  it('appears when every loaded element is hidden by the person, and is gone when the element is shown again', async () => {
    const { client } = knowing([A]);
    const state = createClientState();
    const view = renderApp(`/explore/${INVESTIGATION_A}`, client, state, undefined, stubFactory().create);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    act(() => state.hide([KEY]));
    await act(async () => {
      await view.router.navigate({ pathname: `/explore/${INVESTIGATION_A}` }, { state: { select: KEY } });
    });
    expect(await screen.findByText(ASSISTANT_COPY.selectionNotOnCanvas)).toBeTruthy();
    expect(selected(state)).toEqual([]);
    expect(view.router.state.location.state ?? null).toBeNull();
    act(() => state.presentation.showAllHidden());
    await waitFor(() => expect(screen.queryByText(ASSISTANT_COPY.selectionNotOnCanvas)).toBeNull());
  });

  it('is gone when another investigation is opened on the same route', async () => {
    const B = { investigation: investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1'), node: nodeOf('source-b', 'kind-a', 'C-1') };
    const { client } = knowing([A, B]);
    const view = renderApp({ pathname: `/explore/${INVESTIGATION_A}`, state: { select: OTHER_KEY } }, client, createClientState(), undefined, stubFactory().create);
    expect(await screen.findByText(ASSISTANT_COPY.selectionNotOnCanvas)).toBeTruthy();
    await act(async () => {
      await view.router.navigate(`/explore/${INVESTIGATION_B}`);
    });
    await screen.findByRole('heading', { name: 'kind-a C-1', level: 1 });
    expect(screen.queryByText(ASSISTANT_COPY.selectionNotOnCanvas)).toBeNull();
  });
});

describe('the follow-up referent', () => {
  it('sends the element selected from another window as the selection of the next typed message', async () => {
    const sent: AssistantTurnRequest[] = [];
    const { client } = knowing([A], {
      getAiStatus: async () => ({ ok: true, value: aiStatus({ assistant: 800 }) }),
      assistantTurn: async (request) => {
        sent.push(request);
        return { ok: true as const, value: REFUSE };
      },
      assistantThread: async () => ({ ok: true as const, value: { turns: [], earlierTurns: 0, previousThreadClearedAt: null } }),
    });
    const state = createClientState();
    const view = renderApp(`/explore/${INVESTIGATION_A}`, client, state, undefined, stubFactory().create, undefined, undefined, undefined, createPanelRegistryFor(state));
    const unbind = bindAssistantPanel(state, view.panels, createAssistantSession(null));
    try {
      await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
      const sender = createWindowChannel(SCOPE);
      opened.push(sender);
      const answers: unknown[] = [];
      sender.onSelectionResult((result) => answers.push(result));
      sender.sendSelection([KEY]);
      await waitFor(() => expect(answers).toHaveLength(1));
      act(() => state.presentation.setAssistantOpen(true));
      await userEvent.type(await screen.findByLabelText(ASSISTANT_COPY.fieldLabel), 'what is this?{Enter}');
      await waitFor(() => expect(sent).toHaveLength(1));
      expect((sent[0] as { selectionKeys?: readonly string[] }).selectionKeys).toEqual([KEY]);
    } finally {
      unbind();
    }
  });
});

describe('the note under the element a chat selected', () => {
  async function drawn() {
    const { client } = knowing([A]);
    const state = createClientState();
    const renderer = stubFactory();
    renderApp(`/explore/${INVESTIGATION_A}`, client, state, undefined, renderer.create);
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    const sender = createWindowChannel(SCOPE);
    opened.push(sender);
    const stop = sender.announce('assistant');
    const answers: unknown[] = [];
    sender.onSelectionResult((result) => answers.push(result));
    const noted = () => renderer.made[0]?.scenes.at(-1)?.noted;
    return { state, sender, stop, answers, noted };
  }

  it('is drawn under the element a selection from the chat window selected, and announced politely, with the key as the only thing the chat gave', async () => {
    const h = await drawn();
    expect(h.noted()).toBeUndefined();
    h.sender.sendSelection([KEY]);
    await waitFor(() => expect(h.answers).toHaveLength(1));
    expect(chatSelectionOf(h.state).getState()).toBe(KEY);
    await waitFor(() => expect(h.noted()).toEqual({ key: KEY, text: CHAT_SELECTION_NOTE }));
    const status = await screen.findByText(new RegExp(CHAT_SELECTION_NOTE));
    expect(status.getAttribute('role')).toBe('status');
  });

  it('goes when anything else is selected on this canvas', async () => {
    const h = await drawn();
    h.sender.sendSelection([KEY]);
    await waitFor(() => expect(h.noted()?.key).toBe(KEY));
    act(() => h.state.presentation.select([]));
    await waitFor(() => expect(h.noted()).toBeUndefined());
    expect(chatSelectionOf(h.state).getState()).toBeUndefined();
    expect(screen.queryByText(new RegExp(CHAT_SELECTION_NOTE))).toBeNull();
  });

  it('goes when the chat window that selected it closes', async () => {
    const h = await drawn();
    h.sender.sendSelection([KEY]);
    await waitFor(() => expect(h.noted()?.key).toBe(KEY));
    h.stop();
    await waitFor(() => expect(h.noted()).toBeUndefined());
    expect(chatSelectionOf(h.state).getState()).toBeUndefined();
  });

  it('is not drawn for an element the canvas does not hold, and a selection of that kind leaves no note behind', async () => {
    const h = await drawn();
    h.sender.sendSelection([OTHER_KEY]);
    await waitFor(() => expect(h.answers).toHaveLength(1));
    expect(chatSelectionOf(h.state).getState()).toBeUndefined();
    expect(h.noted()).toBeUndefined();
  });
});
