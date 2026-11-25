import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantThreadResponse, AssistantTurnAnswer } from '@neburyx/contracts';
import { testProfile } from '../dev/test-profile.js';
import { INVESTIGATION_A, investigationOf, knowing, nodeOf } from '../investigations/test-data.js';
import { createClientState } from '../state/client-state.js';
import { aiStatus, countingClient, renderApp } from '../test-utils.js';
import { createPanelRegistryFor } from '../workspace/panel-registry.js';
import { ANSWER_WAIT_MS, createWindowChannel, EXPIRY_MS, type WindowChannel, type WindowScope } from '../windows/window-channel.js';
import { bindAssistantPanel } from './assistant-binder.js';
import { createAssistantSession } from './assistant-session.js';
import { ASSISTANT_COPY } from './copy.js';

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

const PRINCIPAL = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SCOPE: WindowScope = { principalId: PRINCIPAL, investigationId: INVESTIGATION_A, sourceId: 'source-a' };
const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };
const HELD = { sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' };
const GONE = { sourceId: 'source-a', entityType: 'kind-a', stableId: 'GONE-9' };
const EMPTY: AssistantThreadResponse = { turns: [], earlierTurns: 0, previousThreadClearedAt: null };
const ANSWER: AssistantTurnAnswer = {
  status: 'answered',
  route: 'view',
  blocks: [{ kind: 'sentences', sentences: [{ text: 'A-1 is the one element.', cites: ['n1'] }, { text: 'Another was cited.', cites: ['n2'] }] }],
  citations: [
    { key: 'n1', kind: 'entity', ref: HELD },
    { key: 'n2', kind: 'entity', ref: GONE },
  ],
  coverage: { retrieval: '1 shown', summary: 'The draft cites 2 of the 2 shown elements.' },
  model: 'stub-model',
  calls: 1,
} as AssistantTurnAnswer;

const unbinds: (() => void)[] = [];
const opened: WindowChannel[] = [];
let requests: unknown[] = [];

beforeEach(() => {
  FakeBroadcastChannel.all.clear();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  requests = [];
});
afterEach(() => {
  cleanup();
  for (const channel of opened.splice(0)) channel.close();
  for (const unbind of unbinds.splice(0)) unbind();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function page() {
  const known = knowing([A], {
    getAiStatus: async () => ({ ok: true, value: aiStatus({ assistant: 800 }) }),
    assistantTurn: async (request) => {
      requests.push(request);
      return { ok: true as const, value: ANSWER };
    },
    assistantThread: async () => ({ ok: true as const, value: EMPTY }),
  });
  const { calls } = known;
  const counted = countingClient(known.client);
  const client = counted.client;
  const state = createClientState();
  const session = createAssistantSession(null);
  const view = renderApp(`/assistant/${INVESTIGATION_A}`, client, state, undefined, undefined, undefined, undefined, undefined, createPanelRegistryFor(state));
  unbinds.push(bindAssistantPanel(state, view.panels, session));
  await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
  await userEvent.type(await screen.findByLabelText(ASSISTANT_COPY.fieldLabel), 'what is here?{Enter}');
  await userEvent.click(await screen.findByRole('button', { name: /^Sources · 2/ }));
  return { ...view, calls, state, made: counted.count };
}

const row = (n: number) => screen.getByRole('button', { name: new RegExp(`^Sources: ${n},`) });

/** A stand-in for a graph window of the same person, investigation and source: it announces itself and answers a selection with the keys it has. */
function graphWindow(has: readonly string[]) {
  const channel = createWindowChannel(SCOPE);
  opened.push(channel);
  const asked: (readonly string[])[] = [];
  channel.announce('graph');
  channel.onSelection(({ requestId, keys }) => {
    asked.push(keys);
    channel.sendSelectionResult(requestId, keys.filter((key) => has.includes(key)));
  });
  return { channel, asked };
}

const KEY_HELD = JSON.stringify(['node', 'source-a', 'kind-a', 'A-1']);

describe('Select on graph on the Assistant page', () => {
  it('presses a row from the keyboard as from a click, and carries the state text in the row’s accessible name, apart from the marked shade', async () => {
    await page();
    graphWindow([KEY_HELD]);
    await waitFor(() => expect(screen.getByText(ASSISTANT_COPY.graphWindowOpen)).toBeTruthy());
    row(1).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(row(1).getAttribute('aria-label')).toContain(ASSISTANT_COPY.highlightedInGraph));
    expect(row(1).getAttribute('data-selection')).toBe('highlighted');
    expect(row(1).hasAttribute('data-marked')).toBe(false);
  });

  it('sends a message that holds the investigation, the source, the request id and exactly one element key, and nothing of the content', async () => {
    const posted: Record<string, unknown>[] = [];
    const real = FakeBroadcastChannel.prototype.postMessage;
    vi.spyOn(FakeBroadcastChannel.prototype, 'postMessage').mockImplementation(function (this: FakeBroadcastChannel, data: unknown) {
      posted.push(data as Record<string, unknown>);
      real.call(this, data);
    });
    await page();
    graphWindow([KEY_HELD]);
    await waitFor(() => expect(screen.getByText(ASSISTANT_COPY.graphWindowOpen)).toBeTruthy());
    await userEvent.click(row(1));
    const select = posted.find((message) => message['kind'] === 'select');
    expect(Object.keys(select ?? {}).sort()).toEqual(['investigationId', 'keys', 'kind', 'requestId', 'sourceId', 'v', 'windowId']);
    expect(select?.['keys']).toEqual([KEY_HELD]);
    expect(select?.['investigationId']).toBe(INVESTIGATION_A);
    expect(select?.['sourceId']).toBe('source-a');
  });

  it('opens the graph of the investigation with the element selected, the key in the navigation state and not in the address', async () => {
    const h = await page();
    await userEvent.click(row(1));
    await userEvent.click(screen.getByRole('button', { name: ASSISTANT_COPY.openGraph }));
    await waitFor(() => expect(h.router.state.location.pathname).toBe(`/explore/${INVESTIGATION_A}`));
    expect(h.router.state.location.search).toBe('');
    await waitFor(() => expect([...h.state.presentation.view.getState().selection]).toEqual([KEY_HELD]));
  });

  it('shows "Select on graph" on a row of a held element before it is pressed, and "No longer on the graph" for one the investigation does not hold', async () => {
    await page();
    expect(row(1).getAttribute('aria-label')).toContain('Select on graph');
    expect(row(2).getAttribute('aria-label')).toContain('No longer on the graph');
  });

  it('sends one key to an open graph window and shows "Highlighted in the graph window" once the window has answered, and the header shows Graph window open', async () => {
    const h = await page();
    const graph = graphWindow([KEY_HELD]);
    await waitFor(() => expect(screen.getByText(ASSISTANT_COPY.graphWindowOpen)).toBeTruthy());
    const before = h.made();
    await userEvent.click(row(1));
    await waitFor(() => expect(within(row(1)).getByText(ASSISTANT_COPY.highlightedInGraph)).toBeTruthy());
    expect(graph.asked).toEqual([[KEY_HELD]]);
    expect(h.made()).toBe(before);
  });

  it('claims no highlight before the window answers, and falls back to Selected with the notice when none answers', async () => {
    const h = await page();
    const silent = createWindowChannel(SCOPE);
    opened.push(silent);
    silent.announce('graph');
    await waitFor(() => expect(screen.getByText(ASSISTANT_COPY.graphWindowOpen)).toBeTruthy());
    const before = h.made();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => {
      row(1).click();
    });
    expect(screen.queryByText(ASSISTANT_COPY.highlightedInGraph)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(ANSWER_WAIT_MS);
    });
    expect(within(row(1)).getByText(ASSISTANT_COPY.selected)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.noGraphWindow)).toBeTruthy();
    expect(h.made()).toBe(before);
  });

  it('says Not on the canvas when the window answers that it does not hold the element, with no highlight, no Open graph and no request', async () => {
    const h = await page();
    graphWindow([]);
    await waitFor(() => expect(screen.getByText(ASSISTANT_COPY.graphWindowOpen)).toBeTruthy());
    const before = h.made();
    await userEvent.click(row(1));
    await waitFor(() => expect(within(row(1)).getByText(ASSISTANT_COPY.notOnCanvas)).toBeTruthy());
    expect(screen.queryByText(ASSISTANT_COPY.highlightedInGraph)).toBeNull();
    expect(screen.queryByRole('button', { name: ASSISTANT_COPY.openGraph })).toBeNull();
    expect(h.made()).toBe(before);
  });

  it('says Selected with the notice and an Open graph button when no graph window is open, sends nothing, and shows the notice once', async () => {
    const other = createWindowChannel(SCOPE);
    opened.push(other);
    const heard: unknown[] = [];
    other.onSelection((request) => heard.push(request));
    const h = await page();
    const before = h.made();
    await userEvent.click(row(1));
    expect(h.made()).toBe(before);
    expect(within(row(1)).getByText(ASSISTANT_COPY.selected)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.noGraphWindow)).toBeTruthy();
    expect(heard).toEqual([]);
    await userEvent.click(row(1));
    expect(screen.getAllByText(ASSISTANT_COPY.noGraphWindow)).toHaveLength(1);
  });

  it('drops the highlight and the header chip when the graph window goes quiet for the module’s expiry', async () => {
    await page();
    const graph = graphWindow([KEY_HELD]);
    await waitFor(() => expect(screen.getByText(ASSISTANT_COPY.graphWindowOpen)).toBeTruthy());
    await userEvent.click(row(1));
    await waitFor(() => expect(screen.getByText(ASSISTANT_COPY.highlightedInGraph)).toBeTruthy());
    graph.channel.close();
    await waitFor(() => expect(screen.queryByText(ASSISTANT_COPY.graphWindowOpen)).toBeNull());
    expect(screen.queryByText(ASSISTANT_COPY.highlightedInGraph)).toBeNull();
    expect(EXPIRY_MS).toBeGreaterThan(0);
  });

  it('ignores a graph window of another investigation: no chip, and the press sends nothing to it', async () => {
    await page();
    const elsewhere = createWindowChannel({ ...SCOPE, investigationId: 'another-investigation' });
    opened.push(elsewhere);
    const heard: unknown[] = [];
    elsewhere.announce('graph');
    elsewhere.onSelection((request) => heard.push(request));
    await userEvent.click(row(1));
    expect(screen.queryByText(ASSISTANT_COPY.graphWindowOpen)).toBeNull();
    expect(heard).toEqual([]);
  });

  it('shows the highlight after the first answer when two graph windows are open', async () => {
    await page();
    graphWindow([KEY_HELD]);
    graphWindow([KEY_HELD]);
    await waitFor(() => expect(screen.getByText(ASSISTANT_COPY.graphWindowOpen)).toBeTruthy());
    await userEvent.click(row(1));
    await waitFor(() => expect(within(row(1)).getByText(ASSISTANT_COPY.highlightedInGraph)).toBeTruthy());
  });

  it('drops the highlight when the window that reported the element closes while another open window reported that it did not hold it, and keeps the header chip of the other', async () => {
    await page();
    const holds = graphWindow([KEY_HELD]);
    graphWindow([]);
    await waitFor(() => expect(screen.getByText(ASSISTANT_COPY.graphWindowOpen)).toBeTruthy());
    await userEvent.click(row(1));
    await waitFor(() => expect(within(row(1)).getByText(ASSISTANT_COPY.highlightedInGraph)).toBeTruthy());
    holds.channel.close();
    await waitFor(() => expect(screen.queryByText(ASSISTANT_COPY.highlightedInGraph)).toBeNull());
    expect(screen.getByText(ASSISTANT_COPY.graphWindowOpen)).toBeTruthy();
  });

  it('sends nothing for an element the investigation does not hold', async () => {
    await page();
    const graph = graphWindow([KEY_HELD]);
    await waitFor(() => expect(screen.getByText(ASSISTANT_COPY.graphWindowOpen)).toBeTruthy());
    await userEvent.click(row(2));
    expect(graph.asked).toEqual([]);
    expect(screen.getAllByText('No longer on the graph').length).toBeGreaterThan(0);
  });
});
void testProfile;
