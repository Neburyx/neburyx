import { createStore, type ReadableStore } from '../state/store.js';

export type WindowRole = 'graph' | 'assistant';

/** The windows that hear one another: the same person, the same investigation and the same source. */
export interface WindowScope {
  readonly principalId: string;
  readonly investigationId: string;
  readonly sourceId: string;
}

export interface WindowChannel {
  /** False where the browser has no channel or refuses one: nothing is then sent or heard. */
  readonly available: boolean;
  /** Says that this window is open in that role until the returned function is called (or the page is hidden for good). A window not heard from for `EXPIRY_MS` counts as closed. */
  announce(role: WindowRole): () => void;
  /** The roles held by other windows of the scope; this window's own never count. The set is the same object while it does not change. */
  readonly others: ReadableStore<ReadonlySet<WindowRole>>;
  /** Sends the keys of the selected elements to the other windows of the scope: keys, never content. Returns the id of the request, which an answer carries back; `undefined` where the channel is unavailable or the keys are not valid (1 to 100 keys, each non-empty text of at most 200 characters), when nothing is sent. */
  sendSelection(keys: readonly string[]): string | undefined;
  /** Hears the selections of other windows of the scope; the returned function stops listening. */
  onSelection(listener: (request: SelectionRequest) => void): () => void;
  /** Answers a selection: which of its keys the window has on its canvas (0 to 100 keys). Nothing is sent where the request id or a key is not valid. */
  sendSelectionResult(requestId: string, onCanvas: readonly string[]): void;
  /** Hears the answers to the selections this window sent, each of a window that answered within `ANSWER_WAIT_MS` of the selection: one answer of a window to a request counts, a late, repeated or unknown answer is dropped, and `onCanvas` holds only keys that were selected. With several answering windows the listener is called once for each; the keys on the canvas are the union of what they report, so a window that does not have a key never hides another's. A selection nobody answers in that time is never answered: no highlight is to be claimed. */
  onSelectionResult(listener: (result: SelectionResult) => void): () => void;
  close(): void;
}

export interface SelectionRequest {
  readonly requestId: string;
  readonly keys: readonly string[];
}

export interface SelectionResult {
  readonly requestId: string;
  readonly onCanvas: readonly string[];
}

export interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  close(): void;
}

export interface WindowChannelDeps {
  readonly factory?: (name: string) => ChannelLike | undefined;
  readonly now?: () => number;
}

export const HEARTBEAT_MS = 5000;
export const EXPIRY_MS = 15000;
export const MAX_SELECTION_KEYS = 100;
export const MAX_KEY_LENGTH = 200;
export const MAX_REQUEST_ID_LENGTH = 64;
export const ANSWER_WAIT_MS = 3000;
const MAX_PENDING = 50;

const CHANNEL_PREFIX = 'neburyx-windows';
const ROLES: readonly WindowRole[] = ['graph', 'assistant'];
const NO_ROLES: ReadonlySet<WindowRole> = new Set();

type Body = { readonly kind: 'hello' } | { readonly kind: 'presence'; readonly role: WindowRole; readonly open: boolean } | { readonly kind: 'select'; readonly requestId: string; readonly keys: readonly string[] } | { readonly kind: 'selected'; readonly requestId: string; readonly onCanvas: readonly string[] };

const MEMBERS: Readonly<Record<Body['kind'], readonly string[]>> = {
  hello: ['v', 'investigationId', 'sourceId', 'windowId', 'kind'],
  presence: ['v', 'investigationId', 'sourceId', 'windowId', 'kind', 'role', 'open'],
  select: ['v', 'investigationId', 'sourceId', 'windowId', 'kind', 'requestId', 'keys'],
  selected: ['v', 'investigationId', 'sourceId', 'windowId', 'kind', 'requestId', 'onCanvas'],
};

function textKeys(keys: unknown, least: number): keys is readonly string[] {
  return Array.isArray(keys) && keys.length >= least && keys.length <= MAX_SELECTION_KEYS && keys.every((key) => typeof key === 'string' && key !== '' && key.length <= MAX_KEY_LENGTH);
}

function validKeys(keys: unknown): keys is readonly string[] {
  return textKeys(keys, 1);
}

function validRequestId(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 1 && id.length <= MAX_REQUEST_ID_LENGTH;
}

/** What a message says when it is whole, of this scope and of the version: an object with exactly the members of its kind. Anything else is nothing. */
export function readMessage(data: unknown, scope: WindowScope): { readonly windowId: string; readonly body: Body } | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const kind = record['kind'];
  if (kind !== 'hello' && kind !== 'presence' && kind !== 'select' && kind !== 'selected') return undefined;
  const names = Object.keys(record);
  const members = MEMBERS[kind];
  if (names.length !== members.length || !names.every((name) => members.includes(name))) return undefined;
  const windowId = record['windowId'];
  if (record['v'] !== 1 || record['investigationId'] !== scope.investigationId || record['sourceId'] !== scope.sourceId || typeof windowId !== 'string' || windowId === '') return undefined;
  if (kind === 'hello') return { windowId, body: { kind } };
  if (kind === 'presence') {
    const role = record['role'];
    const open = record['open'];
    return ROLES.some((known) => known === role) && typeof open === 'boolean' ? { windowId, body: { kind, role: role as WindowRole, open } } : undefined;
  }
  const requestId = record['requestId'];
  if (!validRequestId(requestId)) return undefined;
  if (kind === 'select') {
    const keys = record['keys'];
    return validKeys(keys) ? { windowId, body: { kind, requestId, keys: [...keys] } } : undefined;
  }
  const onCanvas = record['onCanvas'];
  return textKeys(onCanvas, 0) ? { windowId, body: { kind, requestId, onCanvas: [...onCanvas] } } : undefined;
}

function browserFactory(name: string): ChannelLike | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined;
  try {
    return new BroadcastChannel(name) as unknown as ChannelLike;
  } catch {
    return undefined;
  }
}

function newWindowId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function unavailable(): WindowChannel {
  const others = createStore<ReadonlySet<WindowRole>>(NO_ROLES);
  return { available: false, announce: () => () => undefined, others, sendSelection: () => undefined, onSelection: () => () => undefined, sendSelectionResult: () => undefined, onSelectionResult: () => () => undefined, close: () => undefined };
}

function sameRoles(a: ReadonlySet<WindowRole>, b: ReadonlySet<WindowRole>): boolean {
  return a.size === b.size && [...a].every((role) => b.has(role));
}

/** The channel of one person's windows for one investigation of one source. It carries the open-window state and the selection, as keys; it reads nothing and holds nothing of the investigation. */
export function createWindowChannel(scope: WindowScope, deps: WindowChannelDeps = {}): WindowChannel {
  const channel = (deps.factory ?? browserFactory)(`${CHANNEL_PREFIX}:${scope.principalId}`);
  if (channel === undefined) return unavailable();
  const now = deps.now ?? Date.now;
  const windowId = newWindowId();
  const others = createStore<ReadonlySet<WindowRole>>(NO_ROLES);
  const heard = new Map<string, Map<WindowRole, number>>();
  const mine = new Map<WindowRole, number>();
  const listeners = new Set<(request: SelectionRequest) => void>();
  const resultListeners = new Set<(result: SelectionResult) => void>();
  let closed = false;
  let requests = 0;
  const pending = new Map<string, { readonly keys: readonly string[]; readonly until: number; readonly answered: Set<string> }>();

  const post = (body: Body): void => {
    if (closed) return;
    try {
      channel.postMessage({ v: 1, investigationId: scope.investigationId, sourceId: scope.sourceId, windowId, ...body });
    } catch {
      // a message that cannot be sent is a window that is not heard: the state of the others is rebuilt from their heartbeats
    }
  };
  const publish = (): void => {
    const live = new Set<WindowRole>();
    for (const [id, roles] of heard) {
      for (const [role, seen] of roles) {
        if (now() - seen >= EXPIRY_MS) roles.delete(role);
        else live.add(role);
      }
      if (roles.size === 0) heard.delete(id);
    }
    if (!sameRoles(live, others.getState())) others.setState(live.size === 0 ? NO_ROLES : live);
  };
  const say = (role: WindowRole, open: boolean): void => post({ kind: 'presence', role, open });
  const sayAll = (): void => {
    for (const role of mine.keys()) say(role, true);
  };
  const leave = (): void => {
    for (const role of mine.keys()) say(role, false);
  };

  channel.onmessage = (event) => {
    const message = readMessage(event.data, scope);
    if (message === undefined || message.windowId === windowId || closed) return;
    const { body } = message;
    if (body.kind === 'hello') sayAll();
    else if (body.kind === 'select') for (const listener of [...listeners]) listener({ requestId: body.requestId, keys: body.keys });
    else if (body.kind === 'selected') {
      const asked = pending.get(body.requestId);
      if (asked === undefined || now() > asked.until || asked.answered.has(message.windowId)) return;
      asked.answered.add(message.windowId);
      const onCanvas = body.onCanvas.filter((key) => asked.keys.includes(key));
      for (const listener of [...resultListeners]) listener({ requestId: body.requestId, onCanvas });
    }
    else {
      const roles = heard.get(message.windowId) ?? new Map<WindowRole, number>();
      if (body.open) roles.set(body.role, now());
      else roles.delete(body.role);
      if (roles.size === 0) heard.delete(message.windowId);
      else heard.set(message.windowId, roles);
      publish();
    }
  };
  const timer = setInterval(() => {
    sayAll();
    publish();
  }, HEARTBEAT_MS);
  const hidden = (event: Event): void => {
    if ((event as PageTransitionEvent).persisted !== true) leave();
  };
  const shown = (event: Event): void => {
    if ((event as PageTransitionEvent).persisted === true) sayAll();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', hidden);
    window.addEventListener('pageshow', shown);
  }
  post({ kind: 'hello' });

  return {
    available: true,
    others,
    announce(role) {
      mine.set(role, (mine.get(role) ?? 0) + 1);
      say(role, true);
      let done = false;
      return () => {
        if (done || closed) return;
        done = true;
        const count = (mine.get(role) ?? 1) - 1;
        if (count > 0) mine.set(role, count);
        else {
          mine.delete(role);
          say(role, false);
        }
      };
    },
    sendSelection(keys) {
      if (!validKeys(keys)) return undefined;
      requests += 1;
      const requestId = `${windowId}:${requests}`;
      for (const [id, asked] of pending) if (now() > asked.until) pending.delete(id);
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
      pending.set(requestId, { keys: [...keys], until: now() + ANSWER_WAIT_MS, answered: new Set() });
      post({ kind: 'select', requestId, keys: [...keys] });
      return requestId;
    },
    onSelection(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sendSelectionResult(requestId, onCanvas) {
      if (validRequestId(requestId) && textKeys(onCanvas, 0)) post({ kind: 'selected', requestId, onCanvas: [...onCanvas] });
    },
    onSelectionResult(listener) {
      resultListeners.add(listener);
      return () => {
        resultListeners.delete(listener);
      };
    },
    close() {
      if (closed) return;
      leave();
      closed = true;
      clearInterval(timer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', hidden);
        window.removeEventListener('pageshow', shown);
      }
      listeners.clear();
      resultListeners.clear();
      pending.clear();
      channel.onmessage = null;
      channel.close();
    },
  };
}
