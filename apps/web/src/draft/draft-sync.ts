import { ERROR_TABLE, type DraftWriteRequest, type ErrorCode, type QueryContextDocument } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import type { ClientState } from '../state/client-state.js';
import { createStore, readable, type ReadableStore } from '../state/store.js';
import { draftOf, NOTHING_KEPT, type KeptItems } from './draft-document.js';

/** How long the draft waits after the last change before it is written. */
export const AUTOSAVE_DELAY_MS = 3000;
/** The waits before the first retries of a failed write, and the wait after those; a longer `Retry-After` of the server wins. */
export const RETRY_DELAYS_MS: readonly number[] = [3000, 6000, 12000];
export const RETRY_STEADY_MS = 30000;
/** After this long of failed writes the status says the changes are still not saved. */
export const STALLED_AFTER_MS = 120000;
/** The most a request that outlives the page may carry: below the 64 KiB the browser allows. */
export const KEEPALIVE_LIMIT_BYTES = 60000;

/** What the person is told about the draft; it changes only when the state changes, never on each retry. */
export type DraftStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'failing'; readonly stalled: boolean }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'conflict' };

const IDLE: DraftStatus = { kind: 'idle' };

export interface DraftSession {
  readonly version: number;
  readonly notes: string | null;
  readonly kept?: KeptItems;
  /** The filters of the stored draft, applied once the mapping of the source is known. */
  readonly filters?: QueryContextDocument['filters'];
  /** False until the draft was restored in full or in part: a write before then would replace it with what was not read. */
  readonly writable: boolean;
}

interface Session {
  version: number;
  notes: string | null;
  kept: KeptItems;
  writable: boolean;
  conflicted: boolean;
  pendingFilters: QueryContextDocument['filters'] | undefined;
  /** The document last stored or read, as text. */
  lastJson: string | undefined;
}

export interface Timers {
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly now: () => number;
}

export interface PageEvents {
  addEventListener(type: 'beforeunload' | 'pagehide', listener: (event: Event) => void): void;
  removeEventListener(type: 'beforeunload' | 'pagehide', listener: (event: Event) => void): void;
}

export interface DocumentEvents {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface DraftSyncOptions {
  readonly client: ApiClient;
  readonly state: ClientState;
  readonly timers?: Timers;
  readonly page?: PageEvents;
  readonly document?: DocumentEvents;
}

export interface DraftSync {
  readonly status: ReadableStore<DraftStatus>;
  /** Starts writing the draft of an investigation that is shown: from now on its changes are saved. */
  adopt(investigationId: string, session: DraftSession): void;
  /** Writes at once what is waiting. */
  flush(): void;
  /** Tries again at once, when the writes were refused or are being retried. */
  retry(): void;
  dispose(): void;
}

const realTimers: Timers = { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>), now: () => Date.now() };

type Verdict = 'conflict' | 'retry' | 'rejected';

function verdictOf(failure: ApiFailure): Verdict {
  if (failure.code === 'CONFLICTED_VIEW_VERSION') return 'conflict';
  if (failure.code === 'SCHEMA_MISMATCH') return 'rejected';
  if (!(failure.code in ERROR_TABLE)) return 'retry';
  const status = ERROR_TABLE[failure.code as ErrorCode].status;
  return status >= 500 || status === 429 ? 'retry' : 'rejected';
}

const retryAfterOf = (failure: ApiFailure): number => ('details' in failure && failure.details !== undefined && 'retryAfterMs' in failure.details && typeof failure.details.retryAfterMs === 'number' ? failure.details.retryAfterMs : 0);

export function createDraftSync(options: DraftSyncOptions): DraftSync {
  const { client, state } = options;
  const timers = options.timers ?? realTimers;
  const page: PageEvents | undefined = options.page ?? (typeof window === 'undefined' ? undefined : window);
  const doc: DocumentEvents | undefined = options.document ?? (typeof document === 'undefined' ? undefined : document);
  const status = createStore<DraftStatus>(IDLE);
  const sessions = new Map<string, Session>();
  let timer: unknown;
  let deferred: NonNullable<typeof watched> | undefined;
  let watched: { readonly id: string; readonly session: Session; readonly body: DraftWriteRequest; readonly json: string } | undefined;
  let writing = false;
  let again = false;
  let failureCount = 0;
  let retrying = false;
  let stalled = false;
  let stallTimer: unknown;

  const setStatus = (next: DraftStatus): void => {
    const current = status.getState();
    if (current.kind === next.kind && (current.kind !== 'failing' || next.kind !== 'failing' || current.stalled === next.stalled)) return;
    status.setState(next);
  };

  const shownSession = (): { readonly id: string; readonly session: Session } | undefined => {
    const { id } = state.investigation.getState();
    const session = id === null ? undefined : sessions.get(id);
    return id !== null && session !== undefined && session.writable && !session.conflicted ? { id, session } : undefined;
  };

  const documentOf = (session: Session): DraftWriteRequest => {
    const held = state.investigation.getState();
    return draftOf({ nodeRefs: held.nodeRefs, graph: state.loadedGraph(), presentation: state.presentation.view.getState(), notes: session.notes, kept: session.kept, storedFilters: session.pendingFilters });
  };

  const isDirty = (): boolean => {
    const shown = shownSession();
    if (shown === undefined) return false;
    return JSON.stringify(documentOf(shown.session)) !== shown.session.lastJson;
  };

  const endFailing = (): void => {
    retrying = false;
    stalled = false;
    failureCount = 0;
    if (stallTimer !== undefined) timers.clearTimeout(stallTimer);
    stallTimer = undefined;
  };

  const cancel = (): void => {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (ms: number): void => {
    cancel();
    timer = timers.setTimeout(() => {
      timer = undefined;
      void write();
    }, ms);
  };

  const retryDelay = (failure: ApiFailure): number => Math.max(RETRY_DELAYS_MS[failureCount - 1] ?? RETRY_STEADY_MS, retryAfterOf(failure));

  async function write(keepalive = false): Promise<void> {
    if (writing) {
      again = true;
      return;
    }
    const shown = shownSession();
    if (shown === undefined) return;
    const body = documentOf(shown.session);
    const json = JSON.stringify(body);
    if (json === shown.session.lastJson) return;
    writing = true;
    const { id, session } = shown;
    const result = await client.saveDraft(id, session.version, body, keepalive ? { keepalive: true } : undefined);
    writing = false;
    const stillShown = state.investigation.getState().id === id;
    if (result.ok) {
      session.version = result.value.version;
      session.notes = result.value.notes;
      session.lastJson = json;
      if (stillShown) {
        endFailing();
        setStatus(IDLE);
        const record = state.investigation.getState().record;
        if (record !== null) {
          const save = result.value.save.state === 'saved' ? ({ kind: 'saved', at: result.value.save.savedAt } as const) : ({ kind: 'unsaved' } as const);
          state.describeInvestigation({ ...record, save });
        }
        if (again || isDirty()) {
          again = false;
          schedule(AUTOSAVE_DELAY_MS);
        }
      }
      sendDeferred();
      return;
    }
    again = false;
    const verdict = verdictOf(result.failure);
    if (verdict === 'conflict') {
      session.conflicted = true;
      if (stillShown) {
        cancel();
        endFailing();
        setStatus({ kind: 'conflict' });
      }
      sendDeferred();
      return;
    }
    if (!stillShown) {
      sendDeferred();
      return;
    }
    if (verdict === 'rejected') {
      cancel();
      endFailing();
      setStatus({ kind: 'rejected' });
      return;
    }
    if (!retrying) {
      retrying = true;
      stallTimer = timers.setTimeout(() => {
        stallTimer = undefined;
        if (!retrying) return;
        stalled = true;
        setStatus({ kind: 'failing', stalled: true });
      }, STALLED_AFTER_MS);
    }
    failureCount += 1;
    setStatus({ kind: 'failing', stalled });
    schedule(retryDelay(result.failure));
  }

  /** The draft of the investigation that was shown, sent once when another takes its place, since the timer and the page events look at the one shown. A write of the shown one that is still going on is waited for first. A failure leaves it unsaved, and it is written when that investigation is shown again and changes; a conflict is remembered for when it is. */
  function sendPrevious(previous: NonNullable<typeof watched>): void {
    const { id, session, body, json } = previous;
    if (json === session.lastJson || !session.writable || session.conflicted) return;
    if (writing) {
      deferred = previous;
      return;
    }
    void client.saveDraft(id, session.version, body).then((result) => {
      if (result.ok) {
        session.version = result.value.version;
        session.notes = result.value.notes;
        session.lastJson = json;
      } else if (verdictOf(result.failure) === 'conflict') {
        session.conflicted = true;
      }
    });
  }

  function sendDeferred(): void {
    const waiting = deferred;
    deferred = undefined;
    if (waiting !== undefined) sendPrevious(waiting);
    if (!retrying && !writing && timer === undefined && isDirty()) schedule(AUTOSAVE_DELAY_MS);
  }

  function onChange(): void {
    const currentId = state.investigation.getState().id;
    if (watched !== undefined && watched.id !== currentId) {
      const previous = watched;
      watched = undefined;
      cancel();
      endFailing();
      const next = currentId === null ? undefined : sessions.get(currentId);
      setStatus(next?.conflicted === true ? { kind: 'conflict' } : IDLE);
      sendPrevious(previous);
    }
    const shown = shownSession();
    if (shown === undefined) return;
    applyFilters(shown.session);
    const body = documentOf(shown.session);
    const next = JSON.stringify(body);
    watched = { id: shown.id, session: shown.session, body, json: next };
    if (next === shown.session.lastJson) {
      if (!retrying && !writing) cancel();
      return;
    }
    if (status.getState().kind === 'rejected') setStatus(IDLE);
    if (writing || retrying) return;
    schedule(AUTOSAVE_DELAY_MS);
  }

  function applyFilters(session: Session): void {
    const filters = session.pendingFilters;
    const mapped = state.presentation.view.getState().mappedTypes;
    if (filters === undefined || mapped === undefined) return;
    session.pendingFilters = undefined;
    if (filters.entityTypes.length > 0) for (const type of mapped.entityTypes) if (!filters.entityTypes.includes(type)) state.setEntityTypeOff(type, true);
    if (filters.relTypes.length > 0) for (const type of mapped.relationshipTypes) if (!filters.relTypes.includes(type)) state.setRelationshipTypeOff(type, true);
    const shown = shownSession();
    if (shown !== undefined && shown.session.lastJson !== undefined) shown.session.lastJson = JSON.stringify(documentOf(shown.session));
  }

  const flush = (): void => {
    cancel();
    if (isDirty()) void write();
  };

  const onHidden = (): void => {
    if (doc?.visibilityState === 'hidden') flush();
  };

  const onBeforeUnload = (event: Event): void => {
    if (!isDirty() && !writing) return;
    event.preventDefault();
    Object.assign(event, { returnValue: '' });
  };

  const onPageHide = (): void => {
    const shown = shownSession();
    if (shown === undefined) return;
    const json = JSON.stringify(documentOf(shown.session));
    if (json === shown.session.lastJson) return;
    cancel();
    if (new TextEncoder().encode(json).byteLength <= KEEPALIVE_LIMIT_BYTES) void write(true);
  };

  const unsubscribes = [state.investigation.subscribe(onChange), state.presentation.view.subscribe(onChange), state.server.subscribe(onChange)];
  doc?.addEventListener('visibilitychange', onHidden);
  page?.addEventListener('beforeunload', onBeforeUnload);
  page?.addEventListener('pagehide', onPageHide);

  return {
    status: readable(status),
    adopt(investigationId, session) {
      const adopted: Session = { version: session.version, notes: session.notes, kept: session.kept ?? NOTHING_KEPT, writable: session.writable, conflicted: false, pendingFilters: session.filters, lastJson: undefined };
      sessions.set(investigationId, adopted);
      if (state.investigation.getState().id === investigationId && adopted.writable) {
        applyFilters(adopted);
        adopted.lastJson = JSON.stringify(documentOf(adopted));
      }
    },
    flush,
    retry() {
      const { kind } = status.getState();
      if (kind !== 'rejected' && kind !== 'failing') return;
      if (kind === 'rejected') {
        setStatus(IDLE);
        endFailing();
      }
      flush();
    },
    dispose() {
      cancel();
      endFailing();
      for (const stop of unsubscribes) stop();
      doc?.removeEventListener('visibilitychange', onHidden);
      page?.removeEventListener('beforeunload', onBeforeUnload);
      page?.removeEventListener('pagehide', onPageHide);
    },
  };
}

const syncs = new WeakMap<ClientState, DraftSync>();

/** The one draft sync of a client state: it lives as long as the state does, so a version it holds survives leaving the page and coming back. */
export function draftSyncOf(state: ClientState, client: ApiClient): DraftSync {
  let sync = syncs.get(state);
  if (sync === undefined) {
    sync = createDraftSync({ client, state });
    syncs.set(state, sync);
  }
  return sync;
}
