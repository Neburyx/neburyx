import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWindowChannel, EXPIRY_MS, HEARTBEAT_MS, MAX_KEY_LENGTH, MAX_SELECTION_KEYS, readMessage, type ChannelLike, type WindowChannel, type WindowScope } from './window-channel.js';

const SCOPE: WindowScope = { principalId: 'p1', investigationId: 'inv-1', sourceId: 'src-1' };

interface Hub {
  readonly factory: (name: string) => ChannelLike;
  readonly sent: { readonly name: string; readonly data: unknown }[];
  readonly muted: Set<ChannelLike>;
  readonly created: ChannelLike[];
  deliver(name: string, data: unknown): void;
}

/** A browser channel in memory: a message reaches every other channel of the same name at once. */
function hub(): Hub {
  const open = new Map<string, Set<ChannelLike>>();
  const sent: Hub['sent'] = [];
  const muted = new Set<ChannelLike>();
  const created: ChannelLike[] = [];
  return {
    sent,
    muted,
    created,
    factory(name) {
      const channels = open.get(name) ?? new Set<ChannelLike>();
      open.set(name, channels);
      const channel: ChannelLike = {
        onmessage: null,
        postMessage(data) {
          if (muted.has(channel)) return;
          sent.push({ name, data });
          for (const other of channels) if (other !== channel) other.onmessage?.({ data });
        },
        close() {
          channels.delete(channel);
        },
      };
      channels.add(channel);
      created.push(channel);
      return channel;
    },
    deliver(name, data) {
      for (const channel of open.get(name) ?? []) channel.onmessage?.({ data });
    },
  };
}

const NAME = `neburyx-windows:${SCOPE.principalId}`;
const envelope = (extra: Record<string, unknown>): Record<string, unknown> => ({ v: 1, investigationId: SCOPE.investigationId, sourceId: SCOPE.sourceId, windowId: 'w-other', ...extra });

let opened: WindowChannel[] = [];
const make = (h: Hub, scope: WindowScope = SCOPE): WindowChannel => {
  const channel = createWindowChannel(scope, { factory: h.factory });
  opened.push(channel);
  return channel;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const channel of opened) channel.close();
  opened = [];
  vi.useRealTimers();
});

describe('what a message is', () => {
  it.each([
    ['not an object', 'text'],
    ['null', null],
    ['an array', [1]],
    ['an unknown kind', envelope({ kind: 'open-graph' })],
    ['another version', envelope({ kind: 'hello', v: 2 })],
    ['another investigation', envelope({ kind: 'hello', investigationId: 'inv-2' })],
    ['another source', envelope({ kind: 'hello', sourceId: 'src-2' })],
    ['no window id', envelope({ kind: 'hello', windowId: '' })],
    ['an extra member', envelope({ kind: 'hello', title: 'A title' })],
    ['a presence with an unknown role', envelope({ kind: 'presence', role: 'table', open: true })],
    ['a presence with no flag', envelope({ kind: 'presence', role: 'graph', open: 'yes' })],
    ['a selection with no keys', envelope({ kind: 'select', keys: [] })],
    ['a selection with too many keys', envelope({ kind: 'select', keys: Array.from({ length: MAX_SELECTION_KEYS + 1 }, (_, index) => `k${index}`) })],
    ['a selection with a key that is not text', envelope({ kind: 'select', keys: [1] })],
    ['a selection with an empty key', envelope({ kind: 'select', keys: [''] })],
    ['a selection with a key too long', envelope({ kind: 'select', keys: ['k'.repeat(MAX_KEY_LENGTH + 1)] })],
    ['a selection that also carries text', envelope({ kind: 'select', keys: ['k1'], text: 'content' })],
  ])('is nothing when it is %s', (_name, data) => {
    expect(readMessage(data, SCOPE)).toBeUndefined();
  });

  it('is read when whole, of the scope and of the version', () => {
    expect(readMessage(envelope({ kind: 'hello' }), SCOPE)).toEqual({ windowId: 'w-other', body: { kind: 'hello' } });
    expect(readMessage(envelope({ kind: 'presence', role: 'graph', open: true }), SCOPE)).toEqual({ windowId: 'w-other', body: { kind: 'presence', role: 'graph', open: true } });
    expect(readMessage(envelope({ kind: 'select', keys: ['k'.repeat(MAX_KEY_LENGTH)] }), SCOPE)?.body).toEqual({ kind: 'select', keys: ['k'.repeat(MAX_KEY_LENGTH)] });
  });
});

describe('a channel that is not there', () => {
  it.each([
    ['the browser has none', () => undefined],
    ['the browser refuses one', () => {
      throw new Error('refused');
    }],
  ])('says so, and does nothing, when %s', (_name, factory) => {
    const opened = (() => {
      try {
        return createWindowChannel(SCOPE, { factory });
      } catch {
        return undefined;
      }
    })();
    if (opened === undefined) return;
    expect(opened.available).toBe(false);
    expect(opened.others.getState().size).toBe(0);
    const heard = vi.fn();
    opened.onSelection(heard)();
    opened.announce('assistant')();
    opened.sendSelection(['k1']);
    opened.close();
    expect(heard).not.toHaveBeenCalled();
  });

  it('is unavailable where the browser has no BroadcastChannel', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const channel = createWindowChannel(SCOPE);
    expect(channel.available).toBe(false);
    expect(channel.others.getState().size).toBe(0);
    vi.unstubAllGlobals();
  });

  it('is unavailable where constructing one throws', () => {
    vi.stubGlobal('BroadcastChannel', function Refusing() {
      throw new Error('refused');
    });
    const channel = createWindowChannel(SCOPE);
    expect(channel.available).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('what only the same investigation and source hear', () => {
  it('ignores the presence and the selection of another investigation, another source and another person', () => {
    const h = hub();
    const here = make(h);
    const heard = vi.fn();
    here.onSelection(heard);
    const elsewhere = [make(h, { ...SCOPE, investigationId: 'inv-2' }), make(h, { ...SCOPE, sourceId: 'src-2' })];
    for (const other of elsewhere) {
      other.announce('graph');
      other.sendSelection(['k1']);
    }
    const person = make(h, { ...SCOPE, principalId: 'p2' });
    person.announce('graph');
    person.sendSelection(['k1']);
    expect(here.others.getState().size).toBe(0);
    expect(heard).not.toHaveBeenCalled();
  });

  it('ignores a malformed message that reaches the channel, and goes on hearing the whole ones', () => {
    const h = hub();
    const here = make(h);
    const heard = vi.fn();
    here.onSelection(heard);
    h.deliver(NAME, envelope({ kind: 'select', keys: ['k1'], text: 'x' }));
    h.deliver(NAME, 'garbage');
    h.deliver(NAME, envelope({ kind: 'presence', role: 'graph', open: 1 }));
    expect(heard).not.toHaveBeenCalled();
    expect(here.others.getState().size).toBe(0);
    h.deliver(NAME, envelope({ kind: 'select', keys: ['k1', 'k2'] }));
    expect(heard).toHaveBeenCalledWith(['k1', 'k2']);
  });
});

describe('the selection', () => {
  it('reaches the other windows of the scope as keys and nothing else, and never the window that sent it', () => {
    const h = hub();
    const [a, b, c] = [make(h), make(h), make(h)];
    const [heardA, heardB, heardC] = [vi.fn(), vi.fn(), vi.fn()];
    a.onSelection(heardA);
    b.onSelection(heardB);
    c.onSelection(heardC);
    h.sent.length = 0;
    a.sendSelection(['k1', 'k2']);
    expect(heardA).not.toHaveBeenCalled();
    expect(heardB).toHaveBeenCalledWith(['k1', 'k2']);
    expect(heardC).toHaveBeenCalledWith(['k1', 'k2']);
    expect(h.sent).toHaveLength(1);
    expect(Object.keys(h.sent[0]?.data as object).sort()).toEqual(['investigationId', 'keys', 'kind', 'sourceId', 'v', 'windowId']);
    expect(JSON.stringify(h.sent[0]?.data)).not.toMatch(/title|property|text|count/u);
  });

  it('sends no key that is not valid, and no selection of no key', () => {
    const h = hub();
    const [a, b] = [make(h), make(h)];
    const heard = vi.fn();
    b.onSelection(heard);
    h.sent.length = 0;
    a.sendSelection([]);
    a.sendSelection(['']);
    a.sendSelection(['k'.repeat(MAX_KEY_LENGTH + 1)]);
    a.sendSelection(Array.from({ length: MAX_SELECTION_KEYS + 1 }, (_, index) => `k${index}`));
    expect(h.sent).toHaveLength(0);
    expect(heard).not.toHaveBeenCalled();
  });

  it('stops being heard after the listener is removed and after the channel is closed', () => {
    const h = hub();
    const [a, b] = [make(h), make(h)];
    const heard = vi.fn();
    const stop = b.onSelection(heard);
    stop();
    a.sendSelection(['k1']);
    expect(heard).not.toHaveBeenCalled();
    const later = vi.fn();
    b.onSelection(later);
    b.close();
    a.sendSelection(['k2']);
    expect(later).not.toHaveBeenCalled();
  });
});

describe('the open-window state', () => {
  it('shows the roles of other windows, never its own, and drops a role when its window says it closed', () => {
    const h = hub();
    const [a, b] = [make(h), make(h)];
    const stop = a.announce('graph');
    expect(a.others.getState().size).toBe(0);
    expect([...b.others.getState()]).toEqual(['graph']);
    b.announce('assistant');
    expect([...a.others.getState()]).toEqual(['assistant']);
    stop();
    expect(b.others.getState().size).toBe(0);
  });

  it('is learned by a window opened later, which asks the others to announce themselves', () => {
    const h = hub();
    const a = make(h);
    a.announce('graph');
    const late = make(h);
    expect([...late.others.getState()]).toEqual(['graph']);
  });

  it('keeps a role while one announcement of it is left, and tells the others when the last one ends', () => {
    const h = hub();
    const [a, b] = [make(h), make(h)];
    const first = a.announce('assistant');
    const second = a.announce('assistant');
    first();
    first();
    expect([...b.others.getState()]).toEqual(['assistant']);
    second();
    expect(b.others.getState().size).toBe(0);
  });

  it('holds the same set while it does not change, and tells a subscriber only of a change', () => {
    const h = hub();
    const [a, b] = [make(h), make(h)];
    const listener = vi.fn();
    a.others.subscribe(listener);
    b.announce('graph');
    const before = a.others.getState();
    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(a.others.getState()).toBe(before);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps a window that keeps announcing, however long it is open', () => {
    const h = hub();
    const [a, b] = [make(h), make(h)];
    b.announce('graph');
    vi.advanceTimersByTime(EXPIRY_MS * 4);
    expect([...a.others.getState()]).toEqual(['graph']);
  });

  it('counts a window that crashed as closed once it has not been heard for the expiry, and not before', () => {
    const h = hub();
    const a = make(h);
    const crashed = make(h);
    crashed.announce('assistant');
    expect([...a.others.getState()]).toEqual(['assistant']);
    h.muted.add(h.created[1] as ChannelLike);
    vi.advanceTimersByTime(EXPIRY_MS - HEARTBEAT_MS);
    expect([...a.others.getState()]).toEqual(['assistant']);
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    expect(a.others.getState().size).toBe(0);
  });

  it('says every announced role closed when the page is hidden for good, and not when it goes into the back-forward cache', () => {
    const h = hub();
    const [a, b] = [make(h), make(h)];
    b.announce('graph');
    window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
    expect([...a.others.getState()]).toEqual(['graph']);
    window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
    expect(a.others.getState().size).toBe(0);
  });

  it('says its roles closed when the channel is closed, and does nothing after that', () => {
    const h = hub();
    const [a, b] = [make(h), make(h)];
    b.announce('graph');
    b.close();
    expect(a.others.getState().size).toBe(0);
    const stop = b.announce('assistant');
    stop();
    h.sent.length = 0;
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    expect(h.sent).toHaveLength(0);
  });
});

describe('the module', () => {
  it('imports no API client and makes no request: it has no read path', () => {
    const source = readFileSync(join(import.meta.dirname, 'window-channel.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/gu)].map((match) => match[1]);
    expect(imports).toEqual(['../state/store.js']);
    expect(source).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie/u);
  });
});
