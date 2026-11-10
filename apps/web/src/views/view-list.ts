import type { NamedView, ViewListResponse } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import type { ClientState } from '../state/client-state.js';
import { noteReadOnlyRefusal } from './read-only.js';
import { createStore, readable, type ReadableStore } from '../state/store.js';

export type ViewListState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly failure: ApiFailure }
  | {
      readonly kind: 'ready';
      readonly items: readonly NamedView[];
      readonly nextCursor: string | null;
      /** The exact number of the investigation's named views, as the first page of this read said. */
      readonly count: number;
      readonly draft: ViewListResponse['draft'];
      readonly loadingMore: boolean;
      /** Set when the rows after the last one shown could not be read; the rows shown stay. */
      readonly moreFailed: boolean;
    };

export type RenameOutcome = 'renamed' | 'failed' | 'conflict' | 'unknown';

export interface ViewList {
  readonly state: ReadableStore<ViewListState>;
  /** Reads the first page of the investigation shown, again from the start; a read that is still going is dropped. */
  load(): Promise<void>;
  /** Reads the page after the last one shown. */
  more(): Promise<void>;
  /** Changes a view's name. A name that was taken elsewhere is `conflict`, and the list is read again. */
  rename(viewId: string, name: string): Promise<RenameOutcome>;
  /** Forgets what was read, as when another investigation takes the place of the one shown. */
  reset(): void;
}

const IDLE: ViewListState = { kind: 'idle' };

export function createViewList(client: ApiClient, shown: ClientState): ViewList {
  const store = createStore<ViewListState>(IDLE);
  let read = 0;
  let readOf: string | null = null;

  const investigationId = (): string | null => shown.investigation.getState().id;

  async function load(): Promise<void> {
    const id = investigationId();
    read += 1;
    const mine = read;
    if (id === null) {
      store.setState(IDLE);
      return;
    }
    const sameInvestigation = readOf === id;
    readOf = id;
    // what is shown stays while it is read again, but never the list of another investigation
    if (store.getState().kind !== 'ready' || !sameInvestigation) store.setState({ kind: 'loading' });
    const result = await client.listViews(id, {});
    if (mine !== read) return;
    if (!result.ok) {
      store.setState({ kind: 'failed', failure: result.failure });
      return;
    }
    store.setState({ kind: 'ready', items: result.value.items, nextCursor: result.value.nextCursor, count: result.value.count.value, draft: result.value.draft, loadingMore: false, moreFailed: false });
  }

  async function more(): Promise<void> {
    const current = store.getState();
    const id = readOf;
    if (current.kind !== 'ready' || current.nextCursor === null || current.loadingMore || id === null || id !== investigationId()) return;
    const mine = read;
    store.setState({ ...current, loadingMore: true, moreFailed: false });
    const result = await client.listViews(id, { cursor: current.nextCursor });
    if (mine !== read) return;
    const now = store.getState();
    if (now.kind !== 'ready') return;
    if (!result.ok) {
      store.setState({ ...now, loadingMore: false, moreFailed: true });
      return;
    }
    const seen = new Set(now.items.map((item) => item.id));
    store.setState({ ...now, items: [...now.items, ...result.value.items.filter((item) => !seen.has(item.id))], nextCursor: result.value.nextCursor, loadingMore: false, moreFailed: false });
  }

  async function rename(viewId: string, name: string): Promise<RenameOutcome> {
    const id = investigationId();
    const current = store.getState();
    const item = current.kind === 'ready' ? current.items.find((candidate) => candidate.id === viewId) : undefined;
    if (id === null || id !== readOf || current.kind !== 'ready' || item === undefined) return 'unknown';
    const result = await client.renameView(id, viewId, item.version, name);
    if (!result.ok) {
      if (result.failure.code !== 'CONFLICTED_VIEW_VERSION') {
        noteReadOnlyRefusal(shown, result.failure);
        return 'failed';
      }
      await load();
      return 'conflict';
    }
    const now = store.getState();
    if (now.kind === 'ready' && id === readOf) store.setState({ ...now, items: now.items.map((candidate) => (candidate.id === viewId ? result.value : candidate)) });
    return 'renamed';
  }

  return {
    state: readable(store),
    load,
    more,
    rename,
    reset() {
      read += 1;
      readOf = null;
      store.setState(IDLE);
    },
  };
}

const lists = new WeakMap<ClientState, ViewList>();

/** The one list of views of a client state; it reads the investigation the state shows. */
export function viewListOf(state: ClientState, client: ApiClient): ViewList {
  let list = lists.get(state);
  if (list === undefined) {
    list = createViewList(client, state);
    lists.set(state, list);
  }
  return list;
}
