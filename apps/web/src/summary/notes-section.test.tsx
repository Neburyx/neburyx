import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiNotesResponse, CopyToNotesResponse, SummaryResponse } from '@neburyx/contracts';
import { draftSyncOf } from '../draft/draft-sync.js';
import { ApiClientProvider } from '../api/client-context.js';
import type { ApiResult } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { failure } from '../patterns/patterns-kit.js';
import { createClientState, type ClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { edge, key, node, ref } from '../state/test-data.js';
import { elementKey } from '../state/keys.js';
import { SummaryPanel } from './summary-panel.js';
import { SummarySessionProvider, createSummarySession } from './summary-session.js';

afterEach(cleanup);

const A = ref('a', 'type-a', 'ent-1');
const B = ref('a', 'type-a', 'ent-2');
const EDGE = edge('a', 'rel-1', 'ent-1', 'ent-2');
const SENT = 'n1 type-a ent-1\n  odd   spacing\ne1 rel-a';

const draft = (over: Record<string, unknown> = {}): SummaryResponse =>
  ({
    status: 'ok',
    sentences: [
      { text: 'ent-1 and ent-2 are linked.', cites: ['e1', 'n1', 'n2'] },
      { text: 'ent-2 has one relationship.', cites: ['n2'] },
    ],
    citations: [
      { key: 'n1', kind: 'entity', ref: A },
      { key: 'n2', kind: 'entity', ref: B },
      { key: 'e1', kind: 'relationship', ref: EDGE.ref },
    ],
    coverage: { retrieval: '2 shown · ~38 not yet retrieved (estimated)', summary: 'The draft cites 3 of the 3 shown elements' },
    removedCount: 0,
    sent: SENT,
    model: 'stub-model',
    calls: 2,
    summaryToken: 'tok',
    ...over,
  }) as SummaryResponse;

const RECORD = { title: 'T', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' as const } };

function show(state: ClientState, id: string): void {
  const result = { sourceId: 'a', nodes: [node('a', 'ent-1'), node('a', 'ent-2')], edges: [EDGE] };
  state.show({ id, sourceId: 'a', record: RECORD, resultKeys: [key('a')], nodeRefs: [A, B], edgeRefs: [EDGE.ref] }, [{ key: key('a'), result }]);
}


const SAVE = { state: 'unsaved', savedAt: null } as const;

const ok = (value: SummaryResponse): ApiResult<SummaryResponse> => ({ ok: true, value });


type ReadAnswer = (id: string, mask: boolean, signal: AbortSignal | undefined) => Promise<ApiResult<AiNotesResponse>>;

const entry = (title = 'ent-1'): AiNotesResponse['entries'][number] => ({
  tokenId: 'tok-1',
  label: 'AI-drafted',
  model: 'stub-model',
  generatedAt: '2026-11-15T10:00:00.000Z',
  sentences: [{ text: `${title} is linked to the same source.`, citations: [{ kind: 'entity', ref: A, title, type: 'type-a' }] }],
  coverage: '2 shown · 0 not yet retrieved (exact)',
});
const answer = (entries: AiNotesResponse['entries'] = [entry()]): ApiResult<AiNotesResponse> => ({ ok: true, value: { entries, skipped: [] } });

function notesRig(read: ReadAnswer, copy: (() => Promise<ApiResult<CopyToNotesResponse>>) | undefined = undefined) {
  const state = createClientState();
  state.bindSource('a');
  show(state, 'inv-1');
  const session = createSummarySession();
  const reads: { id: string; mask: boolean; signal: AbortSignal | undefined }[] = [];
  const summaries: number[] = [];
  const client = fakeClient({
    summarize: async () => (summaries.push(1), ok(draft({ sentences: [{ text: 'The record is linked.', cites: ['n1'], storable: true }] }))),
    readAiNotes: async (id, mask, signal) => {
      reads.push({ id, mask, signal });
      return read(id, mask, signal);
    },
    ...(copy === undefined ? {} : { copyToNotes: async () => copy() }),
    saveDraft: async (_id, version, written) => ({ ok: true, value: { version: version + 1, save: { state: 'unsaved', savedAt: null }, notes: written.notes } }),
  });
  draftSyncOf(state, client).adopt('inv-1', { version: 1, notes: null, basedOnViewId: null, writable: true });
  const tree = (open: boolean) => (
    <ApiClientProvider client={client}>
      <ClientStateProvider state={state}>
        <SummarySessionProvider value={session}>{open ? <SummaryPanel onClose={() => undefined} returnToGraph={() => undefined} /> : null}</SummarySessionProvider>
      </ClientStateProvider>
    </ApiClientProvider>
  );
  return { tree, reads, state, client, summaries };
}

const openNotes = async (): Promise<void> => {
  await screen.findByRole('heading', { name: 'Draft' });
  await userEvent.click(screen.getByText('AI notes'));
};

describe('the AI notes of a view in the summary panel', () => {
  it('reads nothing until the section is opened, then shows each entry with its label, model, time, rebuilt sentences and coverage line', async () => {
    const h = notesRig(async () => answer());
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    expect(h.reads).toEqual([]);
    await userEvent.click(screen.getByText('AI notes'));
    expect(await screen.findByText('ent-1 is linked to the same source.')).toBeTruthy();
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0]).toMatchObject({ id: 'inv-1', mask: false });
    expect(screen.getByText('Rebuilt from your own access each time this view opens.')).toBeTruthy();
    expect(screen.getAllByText('stub-model').length).toBeGreaterThan(0);
    expect(screen.getByText('2 shown · 0 not yet retrieved (exact)')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/removed for|dropped/i);
  });

  it('says there are no AI notes for a view with none', async () => {
    const h = notesRig(async () => answer([]));
    render(h.tree(true));
    await openNotes();
    expect(await screen.findByText('No AI notes are saved with this view.')).toBeTruthy();
  });

  it('selects the cited element on the graph when a citation of an entry is pressed', async () => {
    const h = notesRig(async () => answer());
    render(h.tree(true));
    await openNotes();
    await userEvent.click(await screen.findByRole('button', { name: /^ent-1, select on graph/i }));
    expect([...h.state.presentation.view.getState().selection]).toEqual([elementKey(A)]);
  });

  it('reads again after a copy stored something, while the section is open', async () => {
    let read = 0;
    const h = notesRig(async () => answer(read++ === 0 ? [] : [entry()]), async () => ({ ok: true, value: { copied: 1, notCopied: 0, alreadyCopied: false, version: 2, save: { state: 'unsaved', savedAt: null } } }));
    render(h.tree(true));
    await openNotes();
    await screen.findByText('No AI notes are saved with this view.');
    await userEvent.click(screen.getByRole('button', { name: 'Copy to notes' }));
    expect(await screen.findByText('ent-1 is linked to the same source.')).toBeTruthy();
    expect(h.reads).toHaveLength(2);
  });

  it('keeps the entries and offers Try again after a failure of the network, while the context is the same', async () => {
    let read = 0;
    const h = notesRig(async () => (read++ === 0 ? answer() : { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    render(h.tree(true));
    await openNotes();
    await screen.findByText('ent-1 is linked to the same source.');
    act(() => undefined);
    await userEvent.click(screen.getByText('AI notes'));
    await userEvent.click(screen.getByText('AI notes'));
    expect(await screen.findByText(/The AI notes could not be read/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it.each(['ACCESS_DENIED', 'NOT_FOUND'])('clears the entries and says the notes cannot be shown when the read is refused: %s', async (code) => {
    let read = 0;
    const h = notesRig(async () => (read++ === 0 ? answer() : { ok: false, failure: failure(code) }));
    render(h.tree(true));
    await openNotes();
    await screen.findByText('ent-1 is linked to the same source.');
    await userEvent.click(screen.getByText('AI notes'));
    await userEvent.click(screen.getByText('AI notes'));
    expect(await screen.findByText('The AI notes cannot be shown to you.')).toBeTruthy();
    expect(screen.queryByText('ent-1 is linked to the same source.')).toBeNull();
  });

  it('clears and reads again when the masking changes, and never shows a late answer of the earlier masking', async () => {
    const pending: ((value: ApiResult<AiNotesResponse>) => void)[] = [];
    const h = notesRig((_id, mask) => (mask ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve(answer([entry('plain')]))));
    render(h.tree(true));
    await openNotes();
    await screen.findByText('plain is linked to the same source.');
    act(() => h.state.setMask(true));
    await waitFor(() => expect(h.reads).toHaveLength(2));
    expect(h.reads[1]?.mask).toBe(true);
    act(() => h.state.setMask(false));
    await waitFor(() => expect(h.reads).toHaveLength(3));
    await act(async () => pending[0]?.(answer([entry('masked')])));
    expect(screen.queryByText('masked is linked to the same source.')).toBeNull();
    expect(await screen.findByText('plain is linked to the same source.')).toBeTruthy();
  });

  it('clears the entries and reads again for another investigation', async () => {
    const h = notesRig(async (id) => answer([entry(id)]));
    render(h.tree(true));
    await openNotes();
    await screen.findByText('inv-1 is linked to the same source.');
    act(() => show(h.state, 'inv-2'));
    expect(await screen.findByText('inv-2 is linked to the same source.')).toBeTruthy();
    expect(screen.queryByText('inv-1 is linked to the same source.')).toBeNull();
  });
});

describe('the AI notes in changing contexts and from the workspace', () => {
  it('opens on the notes alone without making a draft, and makes one only when Summarize is pressed', async () => {
    const h = notesRig(async () => answer());
    h.state.presentation.openSummaryNotes();
    render(h.tree(true));
    expect(await screen.findByText('ent-1 is linked to the same source.')).toBeTruthy();
    expect(h.reads).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Draft' })).toBeNull();
    expect(h.summaries).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    expect(await screen.findByRole('heading', { name: 'Draft' })).toBeTruthy();
    expect(h.state.presentation.view.getState().summaryNotesOnly).toBe(false);
  });

  it('puts the focus on the notes when they are asked for, and back on the investigation menu when Escape closes the panel', async () => {
    const h = notesRig(async () => answer());
    const menu = document.createElement('button');
    menu.setAttribute('aria-label', 'Investigation menu');
    document.body.append(menu);
    h.state.presentation.openSummaryNotes();
    render(h.tree(true));
    await screen.findByText('ent-1 is linked to the same source.');
    expect(document.activeElement?.textContent).toBe('AI notes');
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).toBe(menu);
    menu.remove();
  });

  it('reads again after a copy that answered it was copied before', async () => {
    let read = 0;
    const h = notesRig(async () => answer(read++ === 0 ? [] : [entry()]), async () => ({ ok: true, value: { copied: 0, notCopied: 0, alreadyCopied: true, version: 2, save: { state: 'unsaved', savedAt: null } } }));
    render(h.tree(true));
    await openNotes();
    await screen.findByText('No AI notes are saved with this view.');
    await userEvent.click(screen.getByRole('button', { name: 'Copy to notes' }));
    expect(await screen.findByText('ent-1 is linked to the same source.')).toBeTruthy();
  });

  it('hides the entries at once and reads again when the view the draft is based on changes, as after a restore', async () => {
    const h = notesRig(async () => answer());
    const view = render(h.tree(true));
    await openNotes();
    await screen.findByText('ent-1 is linked to the same source.');
    draftSyncOf(h.state, h.client).adopt('inv-1', { version: 3, notes: null, basedOnViewId: 'view-2', writable: true });
    view.rerender(h.tree(true));
    await waitFor(() => expect(h.reads).toHaveLength(2));
  });

  it('reads again when the same view is restored again, the results being shown anew', async () => {
    const h = notesRig(async () => answer());
    const view = render(h.tree(true));
    await openNotes();
    await screen.findByText('ent-1 is linked to the same source.');
    draftSyncOf(h.state, h.client).adopt('inv-1', { version: 3, notes: null, basedOnViewId: null, writable: true });
    view.rerender(h.tree(true));
    await waitFor(() => expect(h.reads).toHaveLength(2));
  });

  it('treats a source that changed as a refusal and clears the entries', async () => {
    let read = 0;
    const h = notesRig(async () => (read++ === 0 ? answer() : { ok: false, failure: failure('CONFLICT', { reason: 'source-changed', sourceState: 'repointed' }) }));
    render(h.tree(true));
    await openNotes();
    await screen.findByText('ent-1 is linked to the same source.');
    await userEvent.click(screen.getByText('AI notes'));
    await userEvent.click(screen.getByText('AI notes'));
    expect(await screen.findByText('The AI notes cannot be shown to you.')).toBeTruthy();
    expect(screen.queryByText('ent-1 is linked to the same source.')).toBeNull();
  });
});
