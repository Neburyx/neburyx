import { ExtensionRefusal, assistantThreadResponseSchema, type AssistantThreadTurnWrite, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createAssistantThreadRoute } from './thread-route.js';
import { createMemoryAssistantThreadStore } from './thread-store.js';

const PERSON = '0192f000-0000-7000-8000-000000000001';
const OTHER = '0192f000-0000-7000-8000-000000000002';
const INVESTIGATION = '0192f000-0000-7000-8000-0000000000a1';
const turn = (over: Partial<AssistantThreadTurnWrite> = {}): AssistantThreadTurnWrite => ({ id: crypto.randomUUID(), investigationId: INVESTIGATION, userId: PERSON, at: new Date('2026-11-18T10:00:00Z'), route: 'ask', outcome: 'answered', questionHash: 'a'.repeat(64), intent: 'widgetById', entities: [{ role: 'id', ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' } }], citationRefs: [{ sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }], steps: 1, modelRef: 'm', tokensIn: 5, runId: crypto.randomUUID(), ...over });
const requestOf = (over: Partial<ExtensionRequest> = {}): ExtensionRequest => ({ principalId: PERSON, principalRole: 'investigator', previewOn: true, traceId: 'tr-1', investigation: { id: INVESTIGATION, sourceId: 'demo' }, signal: new AbortController().signal, audit: { record: () => Promise.resolve() }, askClassifier: { availability: () => ({ available: true }), classify: () => Promise.reject(new Error('unused')) }, caseSummarizer: { maxElements: 1, availability: () => ({ available: false, reason: 'off' }), renderForExport: () => ({ status: 'refused' }), summarize: () => Promise.reject(new Error('unused')), recordEarlyEnd: () => Promise.resolve() }, ...over });

describe('the route that reads the thread of an investigation', () => {
  it('declares the investigation of the caller, so a miss is NOT_FOUND before the handler runs, and a GET with no body', () => {
    const route = createAssistantThreadRoute({ threads: () => undefined, limit: () => 100, logger: () => undefined });
    expect(route).toMatchObject({ method: 'GET', url: '/v1/assistant/investigations/:id/thread', permission: 'principal', investigation: { param: 'id', missing: 'NOT_FOUND' } });
    expect(route.requestSchema).toBeUndefined();
  });

  it('answers the caller’s turns in order, as kinds and counts only, and nothing of the hash, the references, the tokens or the run', async () => {
    const store = createMemoryAssistantThreadStore();
    await store.append(turn(), 0);
    await store.append(turn({ route: 'refuse', outcome: 'refused', cause: 'verdict', intent: undefined, entities: [], citationRefs: [], steps: 0 }), 0);
    const answer = assistantThreadResponseSchema.parse(await createAssistantThreadRoute({ threads: () => store, limit: () => 100, logger: () => undefined }).handler(requestOf()));
    expect(answer.turns.map((held) => [held.seq, held.route, held.outcome, held.cause, held.intent, held.citedElements, held.steps])).toEqual([[1, 'ask', 'answered', undefined, 'widgetById', 1, 1], [2, 'refuse', 'refused', 'verdict', undefined, 0, 0]]);
    expect(answer.previousThreadClearedAt).toBeNull();
    expect(JSON.stringify(answer)).not.toMatch(/aaaaaaaa|W-1|modelRef|tokens|runId|questionHash/);
  });

  it('sends the question and the answer item by item under the mask of the query and the current version, and withholds an unbound item only under the mask', async () => {
    const store = createMemoryAssistantThreadStore();
    const answer = { blocks: [{ kind: 'sentences', items: [{ form: 'frozen', text: 'Fixed text.', cites: [] }, { form: 'unbound', text: 'Jordan is listed.', cites: [] }] }] };
    await store.append(turn({ question: 'Who?', maskOn: false, answer: answer as never, sensitivityVersion: 'sv1:a' }), 0);
    const route = createAssistantThreadRoute({ threads: () => store, limit: () => 100, logger: () => undefined });
    const read = async (query: unknown, version: string | undefined) => assistantThreadResponseSchema.parse(await route.handler(requestOf({ query, sensitivityVersion: () => version as string })));
    const items = (shown: Awaited<ReturnType<typeof read>>) => (shown.turns[0]?.answer?.blocks[0]?.kind === 'sentences' ? shown.turns[0].answer.blocks[0].items.map((entry) => entry.item) : []);
    expect(items(await read({ mask: 'true' }, 'sv1:a'))).toEqual([{ state: 'text', text: 'Fixed text.' }, { state: 'withheld' }]);
    expect(items(await read({ mask: 'false' }, 'sv1:a'))[1]).toEqual({ state: 'text', text: 'Jordan is listed.' });
    expect(items(await read(undefined, 'sv1:a'))[1]).toEqual({ state: 'text', text: 'Jordan is listed.' });
    expect(items(await read({ mask: 'true' }, 'sv1:other'))).toEqual([{ state: 'withheld' }, { state: 'withheld' }]);
    expect(items(await read({ mask: 'true' }, undefined))).toEqual([{ state: 'withheld' }, { state: 'withheld' }]);
    expect((await read({ mask: 'true' }, 'sv1:a')).turns[0]?.question).toBe('Who?');
    expect(createAssistantThreadRoute({ threads: () => store, limit: () => 100, logger: () => undefined }).query?.safeParse({ mask: 'maybe' }).success).toBe(false);
  });

  it('treats a version that cannot be read as unknown: every item is withheld under the mask', async () => {
    const store = createMemoryAssistantThreadStore();
    await store.append(turn({ question: 'Who?', maskOn: false, answer: { blocks: [{ kind: 'sentences', items: [{ form: 'frozen', text: 'Fixed text.', cites: [] }] }] } as never, sensitivityVersion: 'sv1:a' }), 0);
    const route = createAssistantThreadRoute({ threads: () => store, limit: () => 100, logger: () => undefined });
    const shown = assistantThreadResponseSchema.parse(await route.handler(requestOf({ query: { mask: 'true' }, sensitivityVersion: () => { throw new Error('down'); } })));
    expect(JSON.stringify(shown.turns[0]?.answer)).not.toContain('Fixed text.');
  });

  it('answers only the caller’s own thread, whoever else has one in the investigation', async () => {
    const store = createMemoryAssistantThreadStore();
    await store.append(turn({ userId: OTHER }), 0);
    const route = createAssistantThreadRoute({ threads: () => store, limit: () => 100, logger: () => undefined });
    expect((await route.handler(requestOf())) as unknown).toEqual({ turns: [], earlierTurns: 0, previousThreadClearedAt: null });
    expect(((await route.handler(requestOf({ principalId: OTHER }))) as { turns: unknown[] }).turns).toHaveLength(1);
  });

  it('gives only as many of the newest turns as the limit says, and how many older ones there are', async () => {
    const store = createMemoryAssistantThreadStore();
    for (let index = 0; index < 5; index += 1) await store.append(turn(), 0);
    const answer = assistantThreadResponseSchema.parse(await createAssistantThreadRoute({ threads: () => store, limit: () => 2, logger: () => undefined }).handler(requestOf()));
    expect([answer.turns.map((held) => held.seq), answer.earlierTurns]).toEqual([[4, 5], 3]);
  });

  it('says when the caller’s previous thread was cleared, and only the caller’s', async () => {
    const store = createMemoryAssistantThreadStore({ now: () => new Date('2026-11-18T12:00:00Z') });
    await store.append(turn(), 0);
    store.clear(INVESTIGATION);
    store.reopen(INVESTIGATION);
    const route = createAssistantThreadRoute({ threads: () => store, limit: () => 100, logger: () => undefined });
    expect(await route.handler(requestOf())).toEqual({ turns: [], earlierTurns: 0, previousThreadClearedAt: '2026-11-18T12:00:00.000Z' });
    expect(await route.handler(requestOf({ principalId: OTHER }))).toEqual({ turns: [], earlierTurns: 0, previousThreadClearedAt: null });
  });

  it('refuses as unsupported without a store or an investigation, and ends in an error with no text of the failure when the store cannot read, logging the investigation id only', async () => {
    expect(await createAssistantThreadRoute({ threads: () => undefined, limit: () => 100, logger: () => undefined }).handler(requestOf()).then(() => undefined, (error: unknown) => error)).toBeInstanceOf(ExtensionRefusal);
    const lines: Record<string, unknown>[] = [];
    const failing = createAssistantThreadRoute({ threads: () => createMemoryAssistantThreadStore({ failOn: 'read' }), limit: () => 100, logger: () => ({ warn: (fields) => void lines.push(fields) }) });
    const error = await failing.handler(requestOf()).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ExtensionRefusal);
    expect(lines).toEqual([{ event: 'assistant-thread.read-failed', investigationId: INVESTIGATION }]);
    await expect(createAssistantThreadRoute({ threads: () => createMemoryAssistantThreadStore(), limit: () => 100, logger: () => undefined }).handler(requestOf({ investigation: undefined }))).rejects.toBeInstanceOf(ExtensionRefusal);
  });
});
