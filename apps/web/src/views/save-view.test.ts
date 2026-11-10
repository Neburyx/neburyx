import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOSAVE_DELAY_MS, RETRY_DELAYS_MS, draftSyncOf } from '../draft/draft-sync.js';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { ref } from '../state/test-data.js';
import { failure, INVESTIGATION_ID, rig, SAVED_AT, savedAnswer, TITLE, VIEW_ID } from './view-fixtures.js';
import { saveNamedView } from './save-view.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const move = (state: ReturnType<typeof rig>['state'], x: number): void => state.presentation.setPosition(elementKey(ref('demo', 'type-a', 'A')), { x, y: 0 });

describe('saving the draft as a named view', () => {
  it('writes the changes that wait before it saves, and carries the draft version that write answered', async () => {
    const { state, client, saves, drafts } = rig();
    move(state, 5);
    const outcome = await saveNamedView(client, state, { name: TITLE, notes: 'a note' });
    expect(outcome).toEqual({ kind: 'saved' });
    expect(drafts).toEqual([{ version: 1, notes: null }]);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ id: INVESTIGATION_ID, draftVersion: 2, body: { name: TITLE, notes: 'a note' } });
  });

  it('sends no save and answers failed when the write that waits fails, and keeps the changes to write again', async () => {
    const { state, client, saves } = rig({ saveDraft: async () => failure('INTERNAL_ERROR') });
    move(state, 5);
    expect(await saveNamedView(client, state, { name: TITLE, notes: null })).toEqual({ kind: 'failed' });
    expect(saves).toEqual([]);
    expect(state.investigation.getState().record?.save).toEqual({ kind: 'unsaved' });
  });

  it('shows the view time, and holds the draft at its new version, notes and view, then autosave goes on from that version', async () => {
    const { state, client, drafts } = rig();
    expect(await saveNamedView(client, state, { name: TITLE, notes: 'a note' })).toEqual({ kind: 'saved' });
    expect(state.investigation.getState().record).toMatchObject({ title: TITLE, version: 3, save: { kind: 'saved', at: SAVED_AT } });
    expect(draftSyncOf(state, client).stateOf(INVESTIGATION_ID)).toEqual({ version: 2, notes: 'a note', basedOnViewId: VIEW_ID });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(drafts).toEqual([]);
    move(state, 9);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(drafts).toEqual([{ version: 2, notes: 'a note' }]);
  });

  it('reads "Unsaved" again after the next content change, when the autosave answer says the draft no longer equals the view', async () => {
    const { state, client } = rig({
      saveDraft: async (_id, version, body) => ({ ok: true, value: { version: version + 1, save: { state: 'unsaved', savedAt: null }, notes: body.notes } }),
    });
    await saveNamedView(client, state, { name: TITLE, notes: null });
    expect(state.investigation.getState().record?.save).toEqual({ kind: 'saved', at: SAVED_AT });
    move(state, 9);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(state.investigation.getState().record?.save).toEqual({ kind: 'unsaved' });
  });

  it('writes the draft under the current mapping before a view is made from it, when that write is still held back by the mapping banner', async () => {
    const { state, client, saves, drafts } = rig({ rehash: true });
    expect(drafts).toEqual([]);
    expect(await saveNamedView(client, state, { name: TITLE, notes: null })).toEqual({ kind: 'saved' });
    expect(drafts).toEqual([{ version: 1, notes: null }]);
    expect(saves[0]?.draftVersion).toBe(2);
  });

  it('shows the failure and creates no view when the write that was held back fails, and writes it again later', async () => {
    let failing = true;
    const { state, client, saves, drafts } = rig({
      rehash: true,
      saveDraft: async (_id, version, body) => {
        if (failing) return failure('INTERNAL_ERROR');
        drafts.push({ version, notes: body.notes });
        return { ok: true, value: { version: version + 1, save: { state: 'unsaved', savedAt: null }, notes: body.notes } };
      },
    });
    expect(await saveNamedView(client, state, { name: TITLE, notes: null })).toEqual({ kind: 'failed' });
    expect(saves).toEqual([]);
    failing = false;
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] ?? 3000);
    expect(drafts).toHaveLength(1);
  });

  it('keeps a change made while the save was in flight, and writes it once the save is over', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { state, client, drafts } = rig({ saveView: (call) => savedAnswer(call) });
    const slow = { ...client, saveView: async (...args: Parameters<typeof client.saveView>) => (await gate, client.saveView(...args)) };
    const pending = saveNamedView(slow, state, { name: TITLE, notes: null });
    await vi.advanceTimersByTimeAsync(0);
    move(state, 7);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(drafts).toEqual([]);
    release();
    expect(await pending).toEqual({ kind: 'saved' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(drafts).toEqual([{ version: 2, notes: null }]);
  });

  it('lets a leave wait for a save in flight, and go on at once when the save finds the draft changed elsewhere', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { state, client } = rig({ saveView: () => failure('CONFLICTED_VIEW_VERSION') });
    const slow = { ...client, saveView: async (...args: Parameters<typeof client.saveView>) => (await gate, client.saveView(...args)) };
    const saving = saveNamedView(slow, state, { name: TITLE, notes: null });
    await vi.advanceTimersByTimeAsync(0);
    let left: boolean | undefined;
    void draftSyncOf(state, client).settle().then((go) => (left = go));
    await vi.advanceTimersByTimeAsync(0);
    expect(left).toBeUndefined();
    release();
    expect(await saving).toEqual({ kind: 'changed-elsewhere' });
    await vi.advanceTimersByTimeAsync(0);
    expect(left).toBe(true);
    expect(draftSyncOf(state, client).leaving.getState()).toBe(false);
  });

  it('sends the title with the version of the investigation when the name differs from it, and shows the title and version the answer carries', async () => {
    const { state, client, saves } = rig();
    expect(await saveNamedView(client, state, { name: 'Ring of five', notes: null })).toEqual({ kind: 'saved' });
    expect(saves[0]?.body).toEqual({ name: 'Ring of five', notes: null, title: 'Ring of five', expectedInvestigationVersion: 3 });
    expect(state.investigation.getState().record).toMatchObject({ title: 'Ring of five', version: 4 });
  });

  it('sends no title when the name is the title', async () => {
    const { state, client, saves } = rig();
    await saveNamedView(client, state, { name: TITLE, notes: null });
    expect(saves[0]?.body).toEqual({ name: TITLE, notes: null });
  });

  it('answers title-conflict and changes nothing when the investigation was renamed elsewhere, so the draft can be saved again', async () => {
    let answers = 0;
    const { state, client, saves } = rig({ saveView: (call) => (answers++ === 0 ? failure('CONFLICT') : savedAnswer(call)) });
    expect(await saveNamedView(client, state, { name: 'Ring of five', notes: null })).toEqual({ kind: 'title-conflict' });
    expect(state.investigation.getState().record).toMatchObject({ title: TITLE, version: 3, save: { kind: 'unsaved' } });
    expect(draftSyncOf(state, client).status.getState()).toEqual({ kind: 'idle' });
    expect(await saveNamedView(client, state, { name: TITLE, notes: null })).toEqual({ kind: 'saved' });
    expect(saves.map((call) => call.draftVersion)).toEqual([1, 1]);
  });

  it('answers changed-elsewhere and puts the draft in its conflict state when the draft version is stale', async () => {
    const { state, client } = rig({ saveView: () => failure('CONFLICTED_VIEW_VERSION') });
    expect(await saveNamedView(client, state, { name: TITLE, notes: null })).toEqual({ kind: 'changed-elsewhere' });
    expect(draftSyncOf(state, client).status.getState()).toEqual({ kind: 'conflict' });
    expect(state.investigation.getState().record?.save).toEqual({ kind: 'unsaved' });
  });

  it('answers changed-elsewhere without sending a save when the draft was already changed elsewhere', async () => {
    const { state, client, saves } = rig({ saveDraft: async () => failure('CONFLICTED_VIEW_VERSION') });
    move(state, 5);
    expect(await saveNamedView(client, state, { name: TITLE, notes: null })).toEqual({ kind: 'changed-elsewhere' });
    expect(saves).toEqual([]);
  });

  it('answers failed and leaves the draft as it was when the save fails for another reason', async () => {
    const { state, client } = rig({ saveView: () => failure('INTERNAL_ERROR') });
    expect(await saveNamedView(client, state, { name: TITLE, notes: 'a note' })).toEqual({ kind: 'failed' });
    expect(draftSyncOf(state, client).stateOf(INVESTIGATION_ID)).toEqual({ version: 1, notes: null, basedOnViewId: null });
    expect(state.investigation.getState().record?.save).toEqual({ kind: 'unsaved' });
  });

  it('answers failed when no investigation is shown', async () => {
    const { client, saves } = rig();
    const empty = createClientState();
    empty.bindSource('demo');
    expect(await saveNamedView(client, empty, { name: TITLE, notes: null })).toEqual({ kind: 'failed' });
    expect(saves).toEqual([]);
  });
});
