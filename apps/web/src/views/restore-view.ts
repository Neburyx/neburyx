import type { RestoreViewResponse } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { draftSyncOf } from '../draft/draft-sync.js';
import { replaceWithDraft } from '../investigations/open-flow.js';
import type { ClientState } from '../state/client-state.js';
import { noteReadOnlyRefusal } from './read-only.js';
import { restoreNoticeOf } from './restore-notice.js';

/**
 * `failed`: the restore was refused and the draft and canvas are as they were. `changed-elsewhere`: the draft changed in another tab, which the draft's own conflict state now says.
 * `read-failed`: the draft was restored on the server but its graph could not be read; the canvas still shows the old graph, autosave is off until `retry` reads it, and `retry` answers the same outcomes again.
 */
export type RestoreOutcome =
  | { readonly kind: 'restored'; readonly someMissing: boolean }
  /** Another investigation was shown before the restored graph was read: the restored one is read anew when it is opened again. */
  | { readonly kind: 'left' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'changed-elsewhere' }
  | { readonly kind: 'read-failed'; readonly failure: ApiFailure; readonly retry: () => Promise<RestoreOutcome> };

async function showRestored(client: ApiClient, state: ClientState, id: string, restored: RestoreViewResponse, signal: AbortSignal | undefined): Promise<RestoreOutcome> {
  const shown = await replaceWithDraft(client, state, restored.draft, { kind: 'saved', at: restored.save.savedAt }, signal);
  // the read was ended or another investigation is shown: the restored draft is on the server, so what is held of it is dropped and the next open reads it
  if (signal?.aborted === true || state.investigation.getState().id !== id) {
    state.forget(id);
    return { kind: 'left' };
  }
  if (shown.kind === 'failed') return { kind: 'read-failed', failure: shown.failure, retry: () => showRestored(client, state, id, restored, signal) };
  restoreNoticeOf(state).set(shown.someMissing);
  return { kind: 'restored', someMissing: shown.someMissing };
}

/**
 * Copies a named view over the draft shown and shows what it holds. An autosave already going on is awaited and the restore carries the version it answered; one that has not been sent is dropped, since the restore replaces the draft whole.
 * The graph is read again through the gate, as a reopen reads it; the signal ends that read only, since the restore itself, once sent, cannot be taken back.
 */
export async function restoreNamedView(client: ApiClient, state: ClientState, viewId: string, signal?: AbortSignal): Promise<RestoreOutcome> {
  const { id } = state.investigation.getState();
  if (id === null) return { kind: 'failed' };
  const sync = draftSyncOf(state, client);
  const held = await sync.hold({ discardPending: true });
  if (held.kind === 'conflict') return { kind: 'changed-elsewhere' };
  if (held.kind !== 'held' || held.hold.id !== id) return { kind: 'failed' };
  const { hold } = held;
  const result = await client.restoreView(id, viewId, hold.version);
  if (!result.ok) {
    if (result.failure.code === 'CONFLICTED_VIEW_VERSION') {
      hold.conflict();
      return { kind: 'changed-elsewhere' };
    }
    hold.release();
    noteReadOnlyRefusal(state, result.failure);
    return { kind: 'failed' };
  }
  const { draft } = result.value;
  hold.release();
  // the draft is held at the version the server answered, and autosave stays off until the graph it names has been read
  sync.adopt(id, { version: draft.version, notes: draft.notes, basedOnViewId: draft.basedOnViewId, writable: false });
  return showRestored(client, state, id, result.value, signal);
}
