import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { CopyToNotesRequest, CopyToNotesResponse, DraftWriteRequest, SummaryResponse } from '@neburyx/contracts';
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

import { draftSyncOf } from '../draft/draft-sync.js';

const SAVE = { state: 'unsaved', savedAt: null } as const;

const ok = (value: SummaryResponse): ApiResult<SummaryResponse> => ({ ok: true, value });

type CopyAnswer = (request: CopyToNotesRequest, id: string) => Promise<ApiResult<CopyToNotesResponse>>;

function copyRig(copy: CopyAnswer, response: SummaryResponse = draft({ sentences: [{ text: 'The record is linked.', cites: ['n1'], storable: true }, { text: 'A name is written.', cites: ['n2'], storable: false }] })) {
  const state = createClientState();
  state.bindSource('a');
  show(state, 'inv-1');
  const session = createSummarySession();
  const copies: { request: CopyToNotesRequest; id: string }[] = [];
  const saves: { version: number; draft: DraftWriteRequest }[] = [];
  const order: string[] = [];
  const client = fakeClient({
    summarize: async () => ok(response),
    copyToNotes: async (id, request) => {
      copies.push({ request, id });
      order.push(`copy v${request.version}`);
      return copy(request, id);
    },
    saveDraft: async (_id, version, written) => {
      saves.push({ version, draft: written });
      order.push(`save v${version}`);
      return { ok: true, value: { version: version + 1, save: SAVE, notes: written.notes } };
    },
  });
  const sync = draftSyncOf(state, client);
  sync.adopt('inv-1', { version: 1, notes: null, basedOnViewId: null, writable: true });
  const tree = (open: boolean) => (
    <ApiClientProvider client={client}>
      <ClientStateProvider state={state}>
        <SummarySessionProvider value={session}>{open ? <SummaryPanel onClose={() => undefined} returnToGraph={() => undefined} /> : null}</SummarySessionProvider>
      </ClientStateProvider>
    </ApiClientProvider>
  );
  return { tree, copies, saves, sync, state, order };
}

const copied = (over: Partial<CopyToNotesResponse> = {}): ApiResult<CopyToNotesResponse> => ({ ok: true, value: { copied: 1, notCopied: 1, alreadyCopied: false, version: 2, save: SAVE, ...over } });

describe('the summary panel: Copy to notes', () => {
  it('is enabled for an unedited draft with a storable sentence, marks the sentences that will not be copied and sends nothing by itself', async () => {
    const h = copyRig(async () => copied());
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    expect((screen.getByRole('button', { name: 'Copy to notes' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByText('Not copied')).toHaveLength(1);
    expect(h.copies).toEqual([]);
  });

  it('sends the token and the draft version, and says how many sentences were copied and how many were not, with those highlighted', async () => {
    const h = copyRig(async () => copied());
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy to notes' }));
    expect(h.copies).toEqual([{ id: 'inv-1', request: { summaryToken: 'tok', version: 1 } }]);
    expect(await screen.findByText("1 sentence copied to notes. 1 of 2 sentences weren't copied: they state numbers or dates in words, which can't be stored.")).toBeTruthy();
    expect(document.querySelectorAll('.summary-block-skipped')).toHaveLength(1);
  });

  it('is disabled after an edit with its message and sends nothing', async () => {
    const h = copyRig(async () => copied());
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.type(screen.getByLabelText('Sentence 1'), ' more');
    expect((screen.getByRole('button', { name: 'Copy to notes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Edited text can't be stored as AI notes.")).toBeTruthy();
    expect(screen.getByText('Edited')).toBeTruthy();
    expect(h.copies).toEqual([]);
  });

  it('is disabled with its message when no sentence is storable', async () => {
    const h = copyRig(async () => copied(), draft({ sentences: [{ text: 'A name.', cites: ['n1'], storable: false }] }));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    expect((screen.getByRole('button', { name: 'Copy to notes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('None of these sentences can be stored as AI notes.')).toBeTruthy();
  });

  it('says a token that was copied before was copied before', async () => {
    const h = copyRig(async () => copied({ copied: 0, notCopied: 0, alreadyCopied: true }));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy to notes' }));
    expect(await screen.findByText('These sentences were copied to notes before.')).toBeTruthy();
  });

  it('says to generate the summary again on ACCESS_DENIED and offers Regenerate, keeping the draft', async () => {
    const h = copyRig(async () => ({ ok: false, failure: failure('ACCESS_DENIED') }));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy to notes' }));
    expect(await screen.findByText('Generate the summary again')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Regenerate' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByLabelText('Sentence 1')).toBeTruthy();
  });

  it.each(['ai-notes-full', 'ai-notes-entry-too-large'])('says the notes cannot take the summary for %s and offers no Try again', async (reason) => {
    const h = copyRig(async () => ({ ok: false, failure: failure('INVALID_REQUEST', { reason }) }));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy to notes' }));
    expect(await screen.findByText('The AI notes of this view cannot take this summary.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows a fixed sentence with Try again for a network failure, and Try again copies again', async () => {
    let call = 0;
    const h = copyRig(async () => (call++ === 0 ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : copied()));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy to notes' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(h.copies).toHaveLength(2);
    expect(await screen.findByText(/1 sentence copied to notes/)).toBeTruthy();
  });
});

describe('the draft version after a copy', () => {
  it('has draft sync adopt the version the copy answered, so the next autosave sends it', async () => {
    const h = copyRig(async () => copied({ version: 2 }));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy to notes' }));
    await screen.findByText(/copied to notes/);
    expect(h.sync.stateOf('inv-1')).toMatchObject({ version: 2, notes: null });
  });

  it('leaves the version as it was for a copy that stored nothing', async () => {
    const h = copyRig(async () => copied({ copied: 0, notCopied: 0, alreadyCopied: true, version: 1 }));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy to notes' }));
    await screen.findByText('These sentences were copied to notes before.');
    expect(h.sync.stateOf('inv-1')).toMatchObject({ version: 1 });
  });

  it('says the view changed elsewhere on a conflict and offers Try again, keeping the draft on screen', async () => {
    const h = copyRig(async () => ({ ok: false, failure: failure('CONFLICTED_VIEW_VERSION') }));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy to notes' }));
    expect(await screen.findByText('This view changed somewhere else. Resolve that first, then copy again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByLabelText('Sentence 1')).toBeTruthy();
  });

  it('holds the draft for the copy, so an autosave waits for it and goes on with the new version', async () => {
    let finish: (value: ApiResult<CopyToNotesResponse>) => void = () => undefined;
    const h = copyRig(() => new Promise((resolve) => (finish = resolve)));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy to notes' }));
    await waitFor(() => expect(h.copies).toHaveLength(1));
    await act(async () => finish(copied({ version: 2 })));
    await screen.findByText(/copied to notes/);
    expect(h.sync.stateOf('inv-1')?.version).toBe(2);
  });
});

describe('Copy to notes in changing contexts', () => {
  it('adopts the save state the copy answered, so a saved view that took a copy is no longer shown as saved', async () => {
    const h = copyRig(async () => copied({ save: { state: 'unsaved', savedAt: null } }));
    const record = h.state.investigation.getState().record;
    if (record === null) throw new Error('the rig shows an investigation');
    h.state.describeInvestigation({ ...record, save: { kind: 'saved', at: '2026-11-15T10:00:00.000Z' } });
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy to notes' }));
    await screen.findByText(/copied to notes/);
    expect(h.state.investigation.getState().record?.save).toEqual({ kind: 'unsaved' });
  });

  it('shows nothing of an answer for an investigation that is no longer on screen', async () => {
    let finish: (value: ApiResult<CopyToNotesResponse>) => void = () => undefined;
    const h = copyRig(() => new Promise((resolve) => (finish = resolve)));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy to notes' }));
    await waitFor(() => expect(h.copies).toHaveLength(1));
    act(() => show(h.state, 'inv-2'));
    await act(async () => finish(copied()));
    expect(screen.queryByText(/copied to notes/)).toBeNull();
  });
});

describe('Copy to notes and an autosave', () => {
  it('writes what waits first, so the copy is made against the version that write answered and the next autosave sends the copy\'s version', async () => {
    const h = copyRig(async () => copied({ version: 3 }));
    render(h.tree(true));
    await screen.findByRole('heading', { name: 'Draft' });
    act(() => h.state.presentation.setPosition(elementKey(A), { x: 10, y: 20 }));
    await userEvent.click(screen.getByRole('button', { name: 'Copy to notes' }));
    await screen.findByText(/copied to notes/);
    expect(h.order).toEqual(['save v1', 'copy v2']);
    expect(h.sync.stateOf('inv-1')?.version).toBe(3);
  });
});
