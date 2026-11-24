import { createHmac } from 'node:crypto';
import { CHAT_INVESTIGATION_IDS_MAX, CHAT_LIST_SCAN_CAP, ExtensionRefusal, assistantThreadListQuerySchema, assistantThreadListResponseSchema, type AssistantThreadTurnWrite, type ChatInvestigation, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createAssistantThreadListRoute } from './thread-list-route.js';
import { createMemoryAssistantThreadStore, type MemoryAssistantThreadStore } from './thread-store.js';

const PERSON = '0192f000-0000-7000-8000-000000000001';
const OTHER = '0192f000-0000-7000-8000-000000000002';
const idOf = (n: number): string => `0192f000-0000-7000-8000-${String(1000 + n).padStart(12, '0')}`;
const sign = (text: string): string => createHmac('sha256', 'a-test-key').update(text).digest('hex');

const turn = (n: number, over: Partial<AssistantThreadTurnWrite> = {}): AssistantThreadTurnWrite => ({
  id: crypto.randomUUID(),
  investigationId: idOf(n),
  userId: PERSON,
  at: new Date(Date.UTC(2026, 10, 18, 10, 0, 0) + n * 60_000),
  route: 'ask',
  outcome: 'answered',
  questionHash: 'a'.repeat(64),
  entities: [],
  citationRefs: [],
  steps: 1,
  question: `Question ${n}`,
  maskOn: false,
  ...over,
} as AssistantThreadTurnWrite);

const named = (n: number, over: Partial<ChatInvestigation> = {}): ChatInvestigation => ({ id: idOf(n), title: `Title ${n}`, caseRef: null, sourceId: 'demo', sourceAlias: 'demo', sourceState: 'available', ...over });

interface Rig {
  readonly store: MemoryAssistantThreadStore;
  readonly asked: number[][];
  readonly call: (query?: Record<string, string>, over?: Partial<ExtensionRequest>) => Promise<ReturnType<typeof assistantThreadListResponseSchema.parse>>;
}

/** `known` is the investigations the application names; every other id is dropped, as the real seam does. */
async function rig(counts: number, known: (n: number) => ChatInvestigation | undefined = named, store = createMemoryAssistantThreadStore()): Promise<Rig> {
  for (let n = 1; n <= counts; n += 1) await store.append(turn(n), 0);
  const asked: number[][] = [];
  const route = createAssistantThreadListRoute({ threads: () => store, logger: () => undefined });
  const call: Rig['call'] = async (query = {}, over = {}) => {
    const request = {
      principalId: PERSON,
      principalRole: 'investigator',
      previewOn: true,
      traceId: 'tr-1',
      query: assistantThreadListQuerySchema.parse(query),
      signText: sign,
      signal: new AbortController().signal,
      chatInvestigations: async (ids: readonly string[]) => {
        asked.push([ids.length]);
        return ids.flatMap((id) => {
          const found = known(Number(id.slice(-4)) - 1000);
          return found === undefined ? [] : [found];
        });
      },
      ...over,
    } as unknown as ExtensionRequest;
    return assistantThreadListResponseSchema.parse(await route.handler(request));
  };
  return { store, asked, call };
}

describe('the route that lists the caller’s chats', () => {
  it('declares a GET on the thread list with its strict query and answer, and no investigation of its own', () => {
    const route = createAssistantThreadListRoute({ threads: () => undefined, logger: () => undefined });
    expect(route).toMatchObject({ method: 'GET', url: '/v1/assistant/threads', permission: 'principal' });
    expect(route.investigation).toBeUndefined();
  });

  it('lists each chat with the fields of the application and the date of the last question, newest first, with no cursor at the end', async () => {
    const { call } = await rig(3);
    const answer = await call();
    expect(answer.items.map((item) => item.investigationId)).toEqual([idOf(3), idOf(2), idOf(1)]);
    expect(answer.items[0]).toEqual({ investigationId: idOf(3), title: 'Title 3', caseRef: null, sourceId: 'demo', sourceAlias: 'demo', sourceState: 'available', lastQuestionAt: '2026-11-18T10:03:00.000Z', turns: 1, lastQuestion: 'Question 3' });
    expect(answer.nextCursor).toBeNull();
  });

  it('cuts a long question to its first 200 code points, and gives the question of the newest turn that has one when the last turn waits', async () => {
    const { store, call } = await rig(0);
    const long = `${'é'.repeat(150)}${'😀'.repeat(100)}`;
    await store.append(turn(1, { question: long }), 0);
    await store.append(turn(2, { question: 'A question asked with a heavy step' }), 0);
    await store.append(turn(2, { question: undefined, maskOn: undefined, outcome: 'waiting', at: new Date(Date.UTC(2026, 10, 18, 11, 0, 0)) }), 0);
    const answer = await call();
    const byId = new Map(answer.items.map((item) => [item.investigationId, item]));
    expect([...(byId.get(idOf(1))?.lastQuestion ?? '')].length).toBe(200);
    expect(byId.get(idOf(1))?.lastQuestion?.startsWith('é'.repeat(150))).toBe(true);
    expect(byId.get(idOf(2))).toMatchObject({ lastQuestion: 'A question asked with a heavy step', turns: 2 });
  });

  it('gives null for a thread of turns that kept no question', async () => {
    const { store, call } = await rig(0);
    await store.append(turn(1, { question: undefined, maskOn: undefined }), 0);
    expect((await call()).items[0]).toMatchObject({ lastQuestion: null, turns: 1 });
  });

  it('drops a thread whose investigation the application does not name, and never lists another person’s thread', async () => {
    const { store, call } = await rig(0, (n) => (n === 2 ? undefined : named(n)));
    for (const n of [1, 2, 3]) await store.append(turn(n), 0);
    await store.append(turn(4, { userId: OTHER }), 0);
    expect((await call()).items.map((item) => item.investigationId)).toEqual([idOf(3), idOf(1)]);
  });

  it('answers an empty list for a person with no thread', async () => {
    const { call } = await rig(0);
    expect(await call()).toEqual({ items: [], nextCursor: null });
  });

  it('answers ASK_UNSUPPORTED when the application gives no seam, no key or no store', async () => {
    const { call } = await rig(1);
    for (const over of [{ chatInvestigations: undefined }, { signText: undefined }]) await expect(call({}, over)).rejects.toBeInstanceOf(ExtensionRefusal);
    const none = createAssistantThreadListRoute({ threads: () => undefined, logger: () => undefined });
    await expect(none.handler({ principalId: PERSON } as unknown as ExtensionRequest)).rejects.toBeInstanceOf(ExtensionRefusal);
  });

  it('is bounded: a page of at most the default 25 and no call names more than a chunk of ids', async () => {
    const { call, asked } = await rig(450);
    const answer = await call();
    expect(answer.items).toHaveLength(25);
    expect(Math.max(...asked.map(([count]) => count ?? 0))).toBeLessThanOrEqual(CHAT_INVESTIGATION_IDS_MAX);
  });

  it('does not take a store that fails for anything but the fixed error, and logs nothing of the person', async () => {
    const logged: unknown[] = [];
    const failing = createAssistantThreadListRoute({ threads: () => createMemoryAssistantThreadStore({ failOn: 'read' }), logger: () => ({ warn: (fields, message) => void logged.push([fields, message]) }) });
    const request = { principalId: PERSON, query: {}, signText: sign, chatInvestigations: async () => [] } as unknown as ExtensionRequest;
    await expect(failing.handler(request)).rejects.toThrow('could not be listed');
    expect(JSON.stringify(logged)).not.toContain(PERSON);
    const quiet = createAssistantThreadListRoute({ threads: () => createMemoryAssistantThreadStore({ failOn: 'read' }), logger: () => { throw new Error('logger down'); } });
    await expect(quiet.handler(request)).rejects.toThrow('could not be listed');
  });
});

describe('the paging of the list of chats', () => {
  it('pages 60 chats in pages of 25, 25 and 10 with none twice or missing', async () => {
    const { call } = await rig(60);
    const first = await call({ limit: '25' });
    const second = await call({ limit: '25', cursor: first.nextCursor ?? '' });
    const third = await call({ limit: '25', cursor: second.nextCursor ?? '' });
    expect([first.items.length, second.items.length, third.items.length]).toEqual([25, 25, 10]);
    expect(first.nextCursor).not.toBeNull();
    expect(third.nextCursor).toBeNull();
    const all = [...first.items, ...second.items, ...third.items].map((item) => item.investigationId);
    expect(new Set(all).size).toBe(60);
    expect(all).toEqual(Array.from({ length: 60 }, (_, index) => idOf(60 - index)));
  });

  it('pages threads of one timestamp without losing or repeating one', async () => {
    const store = createMemoryAssistantThreadStore();
    for (let n = 1; n <= 7; n += 1) await store.append(turn(n, { at: new Date('2026-11-18T10:00:00Z') }), 0);
    const { call } = await rig(0, named, store);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await call({ limit: '3', ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.items.map((item) => item.investigationId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toHaveLength(7);
  });

  it('returns a short page, possibly empty, with a cursor when the scan cap ends before the page is full, and the cursors still yield every remaining chat once', async () => {
    const total = CHAT_LIST_SCAN_CAP * 2 + 30;
    const { call } = await rig(total, (n) => (n <= 5 || n > total - 20 ? undefined : n % 400 === 0 ? named(n) : undefined));
    const kept = Array.from({ length: total }, (_, index) => index + 1).filter((n) => !(n <= 5 || n > total - 20) && n % 400 === 0);
    const seen: string[] = [];
    let cursor: string | undefined;
    let shortWithCursor = false;
    let guard = 0;
    do {
      const page = await call({ limit: '25', ...(cursor === undefined ? {} : { cursor }) });
      if (page.items.length < 25 && page.nextCursor !== null) shortWithCursor = true;
      seen.push(...page.items.map((item) => item.investigationId));
      cursor = page.nextCursor ?? undefined;
      guard += 1;
    } while (cursor !== undefined && guard < 20);
    expect(shortWithCursor).toBe(true);
    expect(new Set(seen)).toEqual(new Set(kept.map((n) => idOf(n))));
    expect(seen).toHaveLength(kept.length);
  });

  it('answers INVALID_REQUEST for a limit of 0 and QUERY_BUDGET_EXCEEDED above 100, and a page of up to 25 for no limit', async () => {
    const { call } = await rig(3);
    await expect(call({ limit: '0' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(call({ limit: '101' })).rejects.toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED' });
    expect((await call({ limit: '100' })).items).toHaveLength(3);
  });

  it('answers CURSOR_INVALIDATED for a cursor of another person, a tampered one, one of another search and a made-up one', async () => {
    const { call } = await rig(30);
    const first = await call({ limit: '10' });
    const cursor = first.nextCursor ?? '';
    await expect(call({ limit: '10', cursor }, { principalId: OTHER })).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
    await expect(call({ limit: '10', cursor: `${cursor}x` })).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
    await expect(call({ limit: '10', cursor: `A${cursor.slice(1)}` })).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
    await expect(call({ limit: '10', q: 'Title', cursor })).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
    await expect(call({ limit: '10', cursor: 'not.a.cursor' })).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
    await expect(call({ limit: '10', cursor: 'nodot' })).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
    await expect(call({ limit: '10', cursor }, { signText: (text) => `${sign(text)}0` })).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
  });
});

describe('the search of the list of chats', () => {
  const titles = new Map([[1, 'Alpha case review'], [2, 'Beta case review']]);
  const questions = new Map([[1, 'Which items were the largest?'], [2, 'Which items use REF-884?']]);
  async function searchable() {
    const store = createMemoryAssistantThreadStore();
    for (const n of [1, 2]) await store.append(turn(n, { question: questions.get(n) }), 0);
    return rig(0, (n) => (titles.has(n) ? named(n, { title: titles.get(n) ?? '' }) : undefined), store);
  }

  it('narrows the list by the shown title and by the last question, whatever the letter case', async () => {
    const { call } = await searchable();
    expect((await call({ q: 'beta' })).items.map((item) => item.investigationId)).toEqual([idOf(2)]);
    expect((await call({ q: 'LARGEST' })).items.map((item) => item.investigationId)).toEqual([idOf(1)]);
    expect((await call({ q: 'items' })).items).toHaveLength(2);
  });

  it('searches the full stored question, not the cut one, and lists a chat whose match lies past the 200th code point', async () => {
    const store = createMemoryAssistantThreadStore();
    await store.append(turn(1, { question: `${'x'.repeat(250)} needle` }), 0);
    const { call } = await rig(0, named, store);
    const answer = await call({ q: 'needle' });
    expect(answer.items).toHaveLength(1);
    expect([...(answer.items[0]?.lastQuestion ?? '')].length).toBe(200);
  });

  it('matches a percent sign, an underscore and a backslash as plain text', async () => {
    const store = createMemoryAssistantThreadStore();
    await store.append(turn(1, { question: '100% sure' }), 0);
    await store.append(turn(2, { question: 'a_b and c\\d' }), 0);
    await store.append(turn(3, { question: 'axb and cd 1000' }), 0);
    const { call } = await rig(0, named, store);
    expect((await call({ q: '0%' })).items.map((item) => item.investigationId)).toEqual([idOf(1)]);
    expect((await call({ q: 'a_b' })).items.map((item) => item.investigationId)).toEqual([idOf(2)]);
    expect((await call({ q: 'c\\d' })).items.map((item) => item.investigationId)).toEqual([idOf(2)]);
    expect((await call({ q: '__' })).items).toEqual([]);
  });

  it('matches the title the application shows, never a stored one it hides', async () => {
    const store = createMemoryAssistantThreadStore();
    await store.append(turn(1, { question: 'plain' }), 0);
    const { call } = await rig(0, (n) => named(n, { title: 'Handle' }), store);
    expect((await call({ q: '+1-212-555-0100' })).items).toEqual([]);
    expect((await call({ q: 'handle' })).items).toHaveLength(1);
  });

  it('answers an empty list with no cursor for a search that matches nothing, and pages the matches of a search', async () => {
    const store = createMemoryAssistantThreadStore();
    for (let n = 1; n <= 40; n += 1) await store.append(turn(n, { question: n % 2 === 0 ? 'even number' : 'odd number' }), 0);
    const { call } = await rig(0, named, store);
    expect(await call({ q: 'nothing here' })).toEqual({ items: [], nextCursor: null });
    const first = await call({ q: 'even', limit: '15' });
    const second = await call({ q: 'even', limit: '15', cursor: first.nextCursor ?? '' });
    expect([first.items.length, second.items.length, second.nextCursor]).toEqual([15, 5, null]);
    expect(new Set([...first.items, ...second.items].map((item) => item.investigationId)).size).toBe(20);
  });

  it('rejects a search text the schema does not accept', async () => {
    const { call } = await rig(1);
    for (const q of ['a', 'x'.repeat(201), 'a\u0000b']) expect(assistantThreadListQuerySchema.safeParse({ q }).success).toBe(false);
  });
});
