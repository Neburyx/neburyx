import { createHmac } from 'node:crypto';
import { ASSISTANT_CHAT_LOOKUP_IDS_MAX, ExtensionRefusal, assistantChatLookupRequestSchema, assistantChatLookupResponseSchema, assistantThreadListQuerySchema, assistantThreadListResponseSchema, type AssistantThreadTurnWrite, type ChatInvestigation, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createAssistantThreadListRoute } from './thread-list-route.js';
import { createAssistantThreadLookupRoute } from './thread-lookup-route.js';
import { createMemoryAssistantThreadStore, type MemoryAssistantThreadStore } from './thread-store.js';

const PERSON = '0192f000-0000-7000-8000-000000000001';
const OTHER = '0192f000-0000-7000-8000-000000000002';
const idOf = (n: number): string => `0192f000-0000-7000-8000-${String(1000 + n).padStart(12, '0')}`;
const sign = (text: string): string => createHmac('sha256', 'a-test-key').update(text).digest('hex');

const turn = (n: number, over: Partial<AssistantThreadTurnWrite> = {}): AssistantThreadTurnWrite =>
  ({ id: crypto.randomUUID(), investigationId: idOf(n), userId: PERSON, at: new Date(Date.UTC(2026, 10, 18, 10, 0, 0) + n * 60_000), route: 'ask', outcome: 'answered', questionHash: 'a'.repeat(64), entities: [], citationRefs: [], steps: 1, question: `Question ${n}`, maskOn: false, ...over }) as AssistantThreadTurnWrite;

const named = (n: number, over: Partial<ChatInvestigation> = {}): ChatInvestigation => ({ id: idOf(n), title: `Title ${n}`, caseRef: null, sourceId: 'demo', sourceAlias: 'demo', sourceState: 'available', ...over });

interface Rig {
  readonly store: MemoryAssistantThreadStore;
  readonly asked: (readonly string[])[];
  readonly lookup: (ids: readonly string[], over?: Partial<ExtensionRequest>) => Promise<{ withChat: string[] }>;
  readonly list: () => Promise<readonly string[]>;
}

/** `known` is the investigations the application names; every other id is dropped, as the real seam does. */
async function rig(chats: readonly number[], known: (n: number) => ChatInvestigation | undefined = named, store = createMemoryAssistantThreadStore()): Promise<Rig> {
  for (const n of chats) await store.append(turn(n), 0);
  const asked: (readonly string[])[] = [];
  const seam = async (ids: readonly string[]) => {
    asked.push(ids);
    return ids.flatMap((id) => {
      const found = known(Number(id.slice(-4)) - 1000);
      return found === undefined ? [] : [found];
    });
  };
  const route = createAssistantThreadLookupRoute({ threads: () => store, logger: () => undefined });
  const lister = createAssistantThreadListRoute({ threads: () => store, logger: () => undefined });
  const request = (over: Partial<ExtensionRequest>): ExtensionRequest => ({ principalId: PERSON, principalRole: 'investigator', previewOn: true, traceId: 'tr-1', signText: sign, signal: new AbortController().signal, chatInvestigations: seam, ...over }) as unknown as ExtensionRequest;
  return {
    store,
    asked,
    lookup: async (ids, over = {}) => assistantChatLookupResponseSchema.parse(await route.handler(request({ body: assistantChatLookupRequestSchema.parse({ investigationIds: ids }), ...over }))),
    list: async () => assistantThreadListResponseSchema.parse(await lister.handler(request({ query: assistantThreadListQuerySchema.parse({ limit: '100' }) }))).items.map((item) => item.investigationId),
  };
}

describe('the route that says which investigations have a chat of the caller', () => {
  it('declares a POST with the strict body and the strict answer, as the other routes of the Assistant do', () => {
    const route = createAssistantThreadLookupRoute({ threads: () => undefined, logger: () => undefined });
    expect(route).toMatchObject({ method: 'POST', url: '/v1/assistant/threads/lookup', permission: 'principal' });
    expect(route.requestSchema).toBe(assistantChatLookupRequestSchema);
    expect(route.responseSchema).toBe(assistantChatLookupResponseSchema);
  });

  it('answers the ids, of those asked, that have a chat of the caller, each once and in the order asked', async () => {
    const { lookup } = await rig([1, 3, 4]);
    expect((await lookup([idOf(4), idOf(2), idOf(1), idOf(3)])).withChat).toEqual([idOf(4), idOf(1), idOf(3)]);
    expect((await lookup([idOf(2)])).withChat).toEqual([]);
  });

  it('never reports a thread of another person, and leaves out an id the application does not name (closed, deleted, not the caller’s, a source the caller may not read)', async () => {
    const store = createMemoryAssistantThreadStore();
    await store.append(turn(1, { userId: OTHER }), 0);
    const { lookup } = await rig([2, 3], (n) => (n === 3 ? undefined : named(n)), store);
    expect((await lookup([idOf(1), idOf(2), idOf(3)])).withChat).toEqual([idOf(2)]);
  });

  it('reports the chat of an investigation whose source was removed or repointed like any other, reading no source', async () => {
    const { lookup } = await rig([1, 2, 3], (n) => named(n, n === 1 ? { sourceState: 'removed' } : n === 2 ? { sourceState: 'repointed' } : {}));
    expect((await lookup([idOf(1), idOf(2), idOf(3)])).withChat).toEqual([idOf(1), idOf(2), idOf(3)]);
  });

  it('counts a chat as the list of chats counts it: the same investigations, whatever the number of turns', async () => {
    const { lookup, list, store } = await rig([1, 2, 3, 4], (n) => (n === 4 ? undefined : named(n)));
    await store.append(turn(5, { question: undefined, maskOn: undefined, outcome: 'waiting' }), 0);
    const ids = [1, 2, 3, 4, 5, 6].map(idOf);
    const listed = new Set(await list());
    expect((await lookup(ids)).withChat).toEqual(ids.filter((id) => listed.has(id)));
  });

  it('asks the application once, for the ids asked and no others, and asks the store for no id the application did not name', async () => {
    const { lookup, asked } = await rig([1]);
    await lookup([idOf(1), idOf(2)]);
    expect(asked).toEqual([[idOf(1), idOf(2)]]);
  });

  it('refuses ASK_UNSUPPORTED with no thread store or no seam to name investigations, and never an empty answer in place of none', async () => {
    const request = (over: Partial<ExtensionRequest>) => ({ principalId: PERSON, body: { investigationIds: [idOf(1)] }, chatInvestigations: async () => [], ...over }) as unknown as ExtensionRequest;
    const withoutStore = createAssistantThreadLookupRoute({ threads: () => undefined, logger: () => undefined });
    await expect(withoutStore.handler(request({}))).rejects.toBeInstanceOf(ExtensionRefusal);
    await expect(withoutStore.handler(request({}))).rejects.toMatchObject({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
    const store = createMemoryAssistantThreadStore();
    const route = createAssistantThreadLookupRoute({ threads: () => store, logger: () => undefined });
    await expect(route.handler(request({ chatInvestigations: undefined }))).rejects.toBeInstanceOf(ExtensionRefusal);
  });

  it('ends in the fixed failure, logging no id, when the store cannot read', async () => {
    const store = createMemoryAssistantThreadStore({ failOn: 'read' });
    const logged: unknown[] = [];
    const route = createAssistantThreadLookupRoute({ threads: () => store, logger: () => ({ warn: (...args: unknown[]) => logged.push(args) }) as never });
    const request = { principalId: PERSON, body: { investigationIds: [idOf(1)] }, chatInvestigations: async (ids: readonly string[]) => ids.map((id) => named(Number(id.slice(-4)) - 1000)) } as unknown as ExtensionRequest;
    await expect(route.handler(request)).rejects.toThrow('the chats of a person could not be looked up');
    expect(JSON.stringify(logged)).not.toContain(idOf(1));
  });
});

describe('the body and the answer of the lookup of chats', () => {
  it('takes 1 to 100 distinct ids and refuses none, more than 100, a repeated id (whatever its case), an id that is not a UUID and an extra member', () => {
    const accepts = (value: unknown): boolean => assistantChatLookupRequestSchema.safeParse(value).success;
    expect(accepts({ investigationIds: [idOf(1)] })).toBe(true);
    expect(accepts({ investigationIds: Array.from({ length: ASSISTANT_CHAT_LOOKUP_IDS_MAX }, (_, n) => idOf(n)) })).toBe(true);
    for (const bad of [{ investigationIds: [] }, { investigationIds: Array.from({ length: ASSISTANT_CHAT_LOOKUP_IDS_MAX + 1 }, (_, n) => idOf(n)) }, { investigationIds: [idOf(1), idOf(1)] }, { investigationIds: [idOf(1), idOf(1).toUpperCase()] }, { investigationIds: ['not-a-uuid'] }, { investigationIds: [idOf(1)], extra: 1 }, {}, [], null]) expect(accepts(bad)).toBe(false);
  });

  it('answers ids only: a title, a question, a count or a date is refused', () => {
    expect(assistantChatLookupResponseSchema.safeParse({ withChat: [idOf(1)] }).success).toBe(true);
    for (const bad of [{ withChat: [idOf(1)], title: 'x' }, { withChat: [{ id: idOf(1), turns: 2 }] }, { withChat: ['x'] }]) expect(assistantChatLookupResponseSchema.safeParse(bad).success).toBe(false);
  });
});
