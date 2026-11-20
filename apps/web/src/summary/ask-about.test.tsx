import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { SummaryResponse } from '@neburyx/contracts';
import { ApiClientProvider } from '../api/client-context.js';
import { fakeClient } from '../api/fake-client.js';
import { createAssistantSession, registerAssistantSession } from '../assistant/assistant-session.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { edge, key, node, ref } from '../state/test-data.js';
import { SUMMARY_COPY } from './copy.js';
import { SummaryPanel } from './summary-panel.js';
import { SummarySessionProvider, createSummarySession } from './summary-session.js';

afterEach(cleanup);

const A = ref('a', 'type-a', 'ent-1');
const B = ref('a', 'type-a', 'ent-2');
const EDGE = edge('a', 'rel-1', 'ent-1', 'ent-2');
const DRAFT = {
  status: 'ok',
  sentences: [
    { text: 'ent-1 and ent-2 are linked.', cites: ['e1', 'n1', 'n2'], storable: false },
    { text: 'ent-2 has one relationship.', cites: ['n2'], storable: false },
  ],
  citations: [
    { key: 'n1', kind: 'entity', ref: A },
    { key: 'n2', kind: 'entity', ref: B },
    { key: 'e1', kind: 'relationship', ref: EDGE.ref },
  ],
  coverage: { retrieval: '2 shown', summary: 'The draft cites 3 of the 3 shown elements' },
  removedCount: 0,
  sent: 'n1',
  model: 'stub-model',
  calls: 1,
  summaryToken: 'v1.token',
} as SummaryResponse;
const RECORD = { title: 'T', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' as const } };

async function draftShown() {
  const state = createClientState();
  state.bindSource('a');
  state.show({ id: 'inv-1', sourceId: 'a', record: RECORD, resultKeys: [key('a')], nodeRefs: [A, B], edgeRefs: [EDGE.ref] }, [{ key: key('a'), result: { sourceId: 'a', nodes: [node('a', 'ent-1'), node('a', 'ent-2')], edges: [EDGE] } }]);
  const assistant = createAssistantSession();
  registerAssistantSession(state, assistant);
  state.presentation.setSummaryOpen(true);
  const client = fakeClient({ summarize: async () => ({ ok: true, value: DRAFT }) });
  render(
    <ApiClientProvider client={client}>
      <ClientStateProvider state={state}>
        <SummarySessionProvider value={createSummarySession()}>
          <SummaryPanel onClose={() => undefined} returnToGraph={() => undefined} />
        </SummarySessionProvider>
      </ClientStateProvider>
    </ApiClientProvider>,
  );
  await screen.findByRole('button', { name: SUMMARY_COPY.regenerate });
  return { state, assistant };
}

describe('Ask about this summary, on the summary panel', () => {
  it('shows the block of frame AS8a after Not saved: the button, the New tag and the line, after Copy to notes, Regenerate and Discard', async () => {
    await draftShown();
    const order = screen.getAllByRole('button').map((button) => button.textContent?.trim());
    const at = (name: string) => order.findIndex((text) => text === name);
    expect(at(SUMMARY_COPY.copyToNotes)).toBeLessThan(at(SUMMARY_COPY.regenerate));
    expect(at(SUMMARY_COPY.regenerate)).toBeLessThan(at(SUMMARY_COPY.discard));
    expect(at(SUMMARY_COPY.discard)).toBeLessThan(at(SUMMARY_COPY.askAbout));
    expect(screen.getByText(SUMMARY_COPY.askNew)).toBeTruthy();
    expect(screen.getByText(SUMMARY_COPY.askNote)).toBeTruthy();
  });

  it('hands the draft to the Assistant, with its token and its sentences as the model wrote them, and opens the Assistant in place of the summary', async () => {
    const { state, assistant } = await draftShown();
    await userEvent.click(screen.getByRole('button', { name: SUMMARY_COPY.askAbout }));
    expect(assistant.store.getState().summary).toMatchObject({ token: 'v1.token', sentences: ['ent-1 and ent-2 are linked.', 'ent-2 has one relationship.'], model: 'stub-model', status: 'attached' });
    expect(state.presentation.view.getState()).toMatchObject({ assistantOpen: true, summaryOpen: false });
  });

  it('replaces the attachment with the new draft when the button is pressed on it again', async () => {
    const { assistant } = await draftShown();
    assistant.store.setState({ ...assistant.store.getState(), summary: { token: 'old', sentences: ['x'], model: 'm', arrivedAt: 1, status: 'invalid' } });
    await userEvent.click(screen.getByRole('button', { name: SUMMARY_COPY.askAbout }));
    expect(assistant.store.getState().summary).toMatchObject({ token: 'v1.token', status: 'attached' });
  });

  it('replaces an attached token with the new draft\'s when the button is pressed on it', async () => {
    const { assistant } = await draftShown();
    assistant.store.setState({ ...assistant.store.getState(), summary: { token: 'old', sentences: ['x'], model: 'm', arrivedAt: 1, status: 'attached' } });
    await userEvent.click(screen.getByRole('button', { name: SUMMARY_COPY.askAbout }));
    expect(assistant.store.getState().summary).toMatchObject({ token: 'v1.token', sentences: ['ent-1 and ent-2 are linked.', 'ent-2 has one relationship.'], status: 'attached' });
  });

  it('keeps what is attached when the draft is made again on the summary panel', async () => {
    const { assistant } = await draftShown();
    await userEvent.click(screen.getByRole('button', { name: SUMMARY_COPY.askAbout }));
    await userEvent.click(screen.getByRole('button', { name: SUMMARY_COPY.regenerate }));
    expect(assistant.store.getState().summary).toMatchObject({ token: 'v1.token', status: 'attached' });
  });

  it('keeps what is attached when the draft is discarded or made again on the summary panel', async () => {
    const { assistant } = await draftShown();
    await userEvent.click(screen.getByRole('button', { name: SUMMARY_COPY.askAbout }));
    await userEvent.click(screen.getByRole('button', { name: SUMMARY_COPY.discard }));
    expect(assistant.store.getState().summary).toMatchObject({ token: 'v1.token', status: 'attached' });
  });
});
