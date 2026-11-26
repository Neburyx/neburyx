import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiNotesResponse } from '@neburyx/contracts';
import { ApiClientProvider } from '../api/client-context.js';
import { fakeClient } from '../api/fake-client.js';
import { READ_WAIT_MS } from '../api/read-wait.js';
import { draftSyncOf } from '../draft/draft-sync.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { key, node } from '../state/test-data.js';
import { drawn, end, ENDINGS, expectBlock, held, press, timesSaid } from '../waiting-kit.js';
import { SummaryPanel } from './summary-panel.js';
import { createSummarySession, SummarySessionProvider } from './summary-session.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SENTENCE = 'Reading the AI notes…';
const NONE: AiNotesResponse = { entries: [], skipped: [] };

async function notes() {
  const state = createClientState();
  state.bindSource('a');
  const shown = node('a', 'ent-1');
  state.show({ id: 'inv-1', sourceId: 'a', record: { title: 'T', caseRef: null, status: 'open', readOnly: false, version: 1, save: { kind: 'unsaved' } }, resultKeys: [key('a')], nodeRefs: [shown.ref], edgeRefs: [] }, [{ key: key('a'), result: { sourceId: 'a', nodes: [shown], edges: [] } }]);
  const reads = held<AiNotesResponse>();
  const client = fakeClient({ readAiNotes: (_id, _mask, signal) => reads.read(signal) });
  draftSyncOf(state, client).adopt('inv-1', { version: 1, notes: null, basedOnViewId: null, writable: true });
  state.presentation.openSummaryNotes();
  render(
    <ApiClientProvider client={client}>
      <ClientStateProvider state={state}>
        <SummarySessionProvider value={createSummarySession()}>
          <SummaryPanel onClose={() => undefined} returnToGraph={() => undefined} />
        </SummarySessionProvider>
      </ClientStateProvider>
    </ApiClientProvider>,
  );
  await drawn();
  return reads;
}

const section = () => document.querySelector('.summary-notes') as HTMLElement;

describe('the AI notes while they are read', () => {
  it.each(ENDINGS)('say so once over a hidden skeleton, and stop on: %s', async (how) => {
    const reads = await notes();
    const waiting = () => {
      expectBlock(SENTENCE, section());
      expect(timesSaid(SENTENCE)).toBe(1);
    };
    waiting();
    await end(how, reads.calls.at(-1), NONE, READ_WAIT_MS, waiting);
    expect(timesSaid(SENTENCE)).toBe(0);
    expect(section().querySelector('.loading-block, .loading-shape, [aria-busy="true"]')).toBeNull();
    if (how === 'answer') expect(screen.getByText('No AI notes are saved with this view.')).toBeTruthy();
    else expect(screen.getByText(/The AI notes could not be read/)).toBeTruthy();
  });

  it('draw the wait again for the read of Try again', async () => {
    const reads = await notes();
    await end('failure', reads.calls.at(-1), NONE, READ_WAIT_MS, () => undefined);
    await press(screen.getByRole('button', { name: 'Try again' }));
    expectBlock(SENTENCE, section());
  });
});
