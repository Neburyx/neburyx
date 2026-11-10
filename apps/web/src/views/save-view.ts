import type { ApiClient } from '../api/client.js';
import { draftSyncOf } from '../draft/draft-sync.js';
import type { ClientState } from '../state/client-state.js';
import { noteReadOnlyRefusal } from './read-only.js';

export interface SaveViewInput {
  readonly name: string;
  readonly notes: string | null;
}

/**
 * `failed`: nothing was saved and the draft is as it was. `title-conflict`: the investigation was renamed elsewhere, nothing was saved.
 * `changed-elsewhere`: the draft changed in another tab, which the draft's own conflict state now says.
 */
export type SaveViewOutcome = { readonly kind: 'saved' } | { readonly kind: 'failed' } | { readonly kind: 'title-conflict' } | { readonly kind: 'changed-elsewhere' };

/** Saves the draft shown as a named view: the changes waiting are written first so the view is the draft as it is, and the write of the view carries the draft's version; the title is sent when the name differs from it. */
export async function saveNamedView(client: ApiClient, state: ClientState, input: SaveViewInput, signal?: AbortSignal): Promise<SaveViewOutcome> {
  const { id, record } = state.investigation.getState();
  if (id === null || record === null) return { kind: 'failed' };
  const held = await draftSyncOf(state, client).hold();
  if (held.kind === 'conflict') return { kind: 'changed-elsewhere' };
  if (held.kind !== 'held' || held.hold.id !== id) return { kind: 'failed' };
  const { hold } = held;
  const retitle = input.name === record.title ? {} : { title: input.name, expectedInvestigationVersion: record.version };
  const result = await client.saveView(id, hold.version, { name: input.name, notes: input.notes, ...retitle }, signal);
  if (!result.ok) {
    if (result.failure.code === 'CONFLICTED_VIEW_VERSION') {
      hold.conflict();
      return { kind: 'changed-elsewhere' };
    }
    hold.release();
    if (noteReadOnlyRefusal(state, result.failure)) return { kind: 'failed' };
    return { kind: result.failure.code === 'CONFLICT' ? 'title-conflict' : 'failed' };
  }
  const { draft, save, investigation } = result.value;
  hold.release({ version: draft.version, notes: draft.notes, basedOnViewId: draft.basedOnViewId });
  const current = state.investigation.getState();
  if (current.id === id && current.record !== null) {
    state.describeInvestigation({ ...current.record, ...(investigation === undefined ? {} : { title: investigation.title, version: investigation.version }), save: { kind: 'saved', at: save.savedAt } });
  }
  return { kind: 'saved' };
}
