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
  await new Promise((resolve) => setTimeout(resolve, 100));
  const before = counted.count();
  const sender = createWindowChannel(SCOPE);
  opened.push(sender);
  const answers: { requestId: string; onCanvas: readonly string[] }[] = [];
  sender.onSelectionResult((result) => answers.push(result));
  return { view, state, sender, answers, calls, made: () => counted.count() - before };
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
    h.sender.sendSelection([KEY]);
    await waitFor(() => expect(h.answers).toHaveLength(1));
    expect(h.answers[0]?.onCanvas).toEqual([KEY]);
    expect(selected(h.state)).toEqual([KEY]);
    expect(h.calls.getInvestigation).toEqual(calls);
    expect(h.made()).toBe(0);
  });

  it('answers with no key and selects and draws nothing for an element it does not hold', async () => {
    const h = await graph();
    h.sender.sendSelection([OTHER_KEY]);
    await waitFor(() => expect(h.answers).toHaveLength(1));
    expect(h.answers[0]?.onCanvas).toEqual([]);
    expect(selected(h.state)).toEqual([]);
    expect(h.made()).toBe(0);
  });

  it('ignores a selection that holds more than one key: nothing selected and no answer', async () => {
    const h = await graph();
    h.sender.sendSelection([KEY, OTHER_KEY]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
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
