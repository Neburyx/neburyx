import { ASSISTANT_CLEAR_OUTCOME_HEADER, ASSISTANT_CLEAR_OUTCOME_UNKNOWN, ExtensionRefusal, auditDetailSchema, assistantThreadClearRequestSchema, assistantThreadClearResponseSchema, type AssistantThreadTurnWrite, type AuditEvent, type ExtensionRequest } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createMemoryAssistantRunStore } from './run-store.js';
import { createAssistantThreadClearRoute } from './thread-clear-route.js';
import { createMemoryAssistantThreadStore } from './thread-store.js';

const PERSON = '0192f000-0000-7000-8000-000000000001';
const OTHER = '0192f000-0000-7000-8000-000000000002';
const INVESTIGATION = '0192f000-0000-7000-8000-0000000000a1';
const ELSEWHERE = '0192f000-0000-7000-8000-0000000000a2';
const turn = (over: Partial<AssistantThreadTurnWrite> = {}): AssistantThreadTurnWrite => ({ id: crypto.randomUUID(), investigationId: INVESTIGATION, userId: PERSON, at: new Date('2026-11-18T10:00:00Z'), route: 'ask', outcome: 'answered', questionHash: 'a'.repeat(64), entities: [], citationRefs: [], steps: 1, question: 'Who is connected?', maskOn: false, ...over });
const requestOf = (over: Partial<ExtensionRequest> = {}): ExtensionRequest => ({ principalId: PERSON, principalRole: 'investigator', previewOn: true, traceId: 'tr-1', investigation: { id: INVESTIGATION, sourceId: 'demo' }, signal: new AbortController().signal, audit: { record: () => Promise.resolve() }, askClassifier: { availability: () => ({ available: true }), classify: () => Promise.reject(new Error('unused')) }, caseSummarizer: { maxElements: 1, availability: () => ({ available: false, reason: 'off' }), renderForExport: () => ({ status: 'refused' }), summarize: () => Promise.reject(new Error('unused')), recordEarlyEnd: () => Promise.resolve() }, ...over });

async function runWithText(runs: ReturnType<typeof createMemoryAssistantRunStore>, actorId: string, investigationId: string): Promise<void> {
  const id = crypto.randomUUID();
  await runs.begin({ id, actorId, investigationId, sourceId: 'demo', traceId: 't', startedAt: new Date('2026-11-18T10:00:00Z'), settings: {} });
  await runs.beginCall({ runId: id, number: 1, startedAt: new Date('2026-11-18T10:00:00Z'), instructionsSha256: 'h', instructionsText: 'fixed instructions', valuesText: 'values of the turn' });
  await runs.endCall({ runId: id, number: 1, status: 'answered', replyText: 'the reply', tokensIn: 7, tokensOut: 9, durationMs: 12 });
}
const textOf = (runs: ReturnType<typeof createMemoryAssistantRunStore>, actorId: string, investigationId: string): string =>
  JSON.stringify(runs.runs.filter((run) => run.start.actorId === actorId && run.start.investigationId === investigationId).map((run) => [run.callStarts.map((call) => call.valuesText), run.callEnds.map((call) => call.replyText)]));

describe('the route that clears the caller’s own thread', () => {
  it('declares a POST with the strict empty body, the investigation of the caller (NOT_FOUND before the handler) and the strict answer', () => {
    const route = createAssistantThreadClearRoute({ threads: () => undefined, logger: () => undefined });
    expect(route).toMatchObject({ method: 'POST', url: '/v1/assistant/investigations/:id/thread/clear', permission: 'principal', investigation: { param: 'id', missing: 'NOT_FOUND' } });
    expect(route.requestSchema).toBe(assistantThreadClearRequestSchema);
    expect(assistantThreadClearRequestSchema.safeParse({}).success).toBe(true);
    for (const body of [{ cleared: true }, { a: 1 }, [], 'x', null, undefined, 3]) expect(assistantThreadClearRequestSchema.safeParse(body).success).toBe(false);
    expect(assistantThreadClearResponseSchema.safeParse({ cleared: true, turns: 2 }).success).toBe(false);
  });

  it('deletes the caller’s thread and blanks the call text of their runs of the investigation, leaves the rows, and answers cleared true once, false after', async () => {
    const runs = createMemoryAssistantRunStore();
    const threads = createMemoryAssistantThreadStore({ blankRunText: (investigationId, userId) => runs.blankText(investigationId, userId) });
    await threads.append(turn(), 0);
    await runWithText(runs, PERSON, INVESTIGATION);
    const route = createAssistantThreadClearRoute({ threads: () => threads, logger: () => undefined });
    expect(assistantThreadClearResponseSchema.parse(await route.handler(requestOf()))).toEqual({ cleared: true });
    expect((await threads.read(INVESTIGATION, PERSON, 100)).turns).toHaveLength(0);
    expect(textOf(runs, PERSON, INVESTIGATION)).toBe('[[[""],[null]]]');
    const run = runs.runs[0];
    expect([runs.runs.length, run?.callStarts[0]?.instructionsText, run?.callEnds[0]?.tokensIn, run?.callEnds[0]?.status]).toEqual([1, 'fixed instructions', 7, 'answered']);
    expect(assistantThreadClearResponseSchema.parse(await route.handler(requestOf()))).toEqual({ cleared: false });
  });

  it('moves the person’s count with every call, also the one that finds no thread to delete', async () => {
    const threads = createMemoryAssistantThreadStore();
    const route = createAssistantThreadClearRoute({ threads: () => threads, logger: () => undefined });
    await threads.append(turn(), 0);
    const counts: number[] = [await threads.epoch(INVESTIGATION, PERSON)];
    for (let call = 0; call < 3; call += 1) {
      await route.handler(requestOf());
      counts.push(await threads.epoch(INVESTIGATION, PERSON));
    }
    expect(counts).toEqual([0, 1, 2, 3]);
    expect(await threads.epoch(INVESTIGATION, OTHER)).toBe(0);
  });

  it('blanks the text of a run that has no stored thread yet and answers cleared false', async () => {
    const runs = createMemoryAssistantRunStore();
    const threads = createMemoryAssistantThreadStore({ blankRunText: (investigationId, userId) => runs.blankText(investigationId, userId) });
    await runWithText(runs, PERSON, INVESTIGATION);
    expect(await createAssistantThreadClearRoute({ threads: () => threads, logger: () => undefined }).handler(requestOf())).toEqual({ cleared: false });
    expect(textOf(runs, PERSON, INVESTIGATION)).not.toContain('values of the turn');
    expect(textOf(runs, PERSON, INVESTIGATION)).not.toContain('the reply');
  });

  it('leaves another person’s thread and run text, and the caller’s other investigation, as they were', async () => {
    const runs = createMemoryAssistantRunStore();
    const threads = createMemoryAssistantThreadStore({ blankRunText: (investigationId, userId) => runs.blankText(investigationId, userId) });
    await threads.append(turn(), 0);
    await threads.append(turn({ userId: OTHER }), 0);
    await threads.append(turn({ investigationId: ELSEWHERE }), 0);
    for (const [actor, investigation] of [[PERSON, INVESTIGATION], [OTHER, INVESTIGATION], [PERSON, ELSEWHERE]] as const) await runWithText(runs, actor, investigation);
    await createAssistantThreadClearRoute({ threads: () => threads, logger: () => undefined }).handler(requestOf());
    expect((await threads.read(INVESTIGATION, OTHER, 100)).turns).toHaveLength(1);
    expect((await threads.read(ELSEWHERE, PERSON, 100)).turns).toHaveLength(1);
    expect(textOf(runs, OTHER, INVESTIGATION)).toContain('values of the turn');
    expect(textOf(runs, PERSON, ELSEWHERE)).toContain('the reply');
  });

  it('answers ASK_UNSUPPORTED with no store or no investigation', async () => {
    await expect(createAssistantThreadClearRoute({ threads: () => undefined, logger: () => undefined }).handler(requestOf())).rejects.toBeInstanceOf(ExtensionRefusal);
    await expect(createAssistantThreadClearRoute({ threads: () => createMemoryAssistantThreadStore(), logger: () => undefined }).handler(requestOf({ investigation: undefined }))).rejects.toBeInstanceOf(ExtensionRefusal);
  });

  it('fails with a fixed error that holds no text of the failure, and logs the investigation’s id only; a logger that throws changes nothing', async () => {
    const logged: unknown[] = [];
    const failing = createMemoryAssistantThreadStore({ failOn: 'clear' });
    const route = createAssistantThreadClearRoute({ threads: () => failing, logger: () => ({ warn: (fields, message) => void logged.push([fields, message]) }) });
    const error = await route.handler(requestOf()).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ExtensionRefusal);
    expect(JSON.stringify(logged)).toContain(INVESTIGATION);
    expect(JSON.stringify(logged)).not.toMatch(/Who is connected|values of the turn/);
    const quiet = createAssistantThreadClearRoute({ threads: () => failing, logger: () => { throw new Error('logger down'); } });
    await expect(quiet.handler(requestOf())).rejects.toThrow('could not be cleared');
  });
});

describe('the event of a clearing', () => {
  const recorded = (): { readonly events: AuditEvent[]; readonly request: (over?: Partial<ExtensionRequest>) => ExtensionRequest } => {
    const events: AuditEvent[] = [];
    return { events, request: (over = {}) => requestOf({ audit: { record: (event) => (events.push(event), Promise.resolve()) }, ...over }) };
  };

  it('is one queued event with the actor, the investigation and the source, the result success and only whether a thread was deleted, and holds no text, hash, count of turns or run id', async () => {
    const { events, request } = recorded();
    const threads = createMemoryAssistantThreadStore();
    await threads.append(turn({ runId: crypto.randomUUID() }), 0);
    const route = createAssistantThreadClearRoute({ threads: () => threads, logger: () => undefined });
    await route.handler(request());
    expect(events).toEqual([{ actorId: PERSON, actorRole: 'investigator', action: 'assistant.thread.cleared', result: 'success', sourceId: 'demo', investigationId: INVESTIGATION, traceId: 'tr-1', detail: { threadClear: { cleared: true } } }]);
    expect(auditDetailSchema.safeParse(events[0]?.detail).success).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/Who is connected|a{16}|runId|turns/);
    await route.handler(request());
    expect(events[1]?.detail).toEqual({ threadClear: { cleared: false } });
  });

  it('rejects a detail that carries anything beside the boolean', () => {
    for (const detail of [{ threadClear: { cleared: true, turns: 3 } }, { threadClear: { cleared: 'yes' } }, { threadClear: {} }, { threadClear: { cleared: true }, reason: 'cancelled' }]) expect(auditDetailSchema.safeParse(detail).success).toBe(false);
  });

  it('is a failed event with no detail when the store failed, and the answer is the same failure', async () => {
    const { events, request } = recorded();
    const route = createAssistantThreadClearRoute({ threads: () => createMemoryAssistantThreadStore({ failOn: 'clear' }), logger: () => undefined });
    await expect(route.handler(request())).rejects.toThrow('could not be cleared');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'assistant.thread.cleared', result: 'failed' });
    expect(events[0]?.detail).toBeUndefined();
  });

  it('does not change the answer when the event cannot be queued', async () => {
    const threads = createMemoryAssistantThreadStore();
    await threads.append(turn(), 0);
    const route = createAssistantThreadClearRoute({ threads: () => threads, logger: () => undefined });
    expect(await route.handler(requestOf({ audit: { record: () => Promise.reject(new Error('queue down')) } }))).toEqual({ cleared: true });
  });

  it('is written for no clearing that was refused before the handler: a missing store writes nothing', async () => {
    const { events, request } = recorded();
    await expect(createAssistantThreadClearRoute({ threads: () => undefined, logger: () => undefined }).handler(request())).rejects.toBeInstanceOf(ExtensionRefusal);
    expect(events).toEqual([]);
  });
  it('marks the answer with the header when the commit failed, and with none for a failure that rolled back', async () => {
    const headers: [string, string][] = [];
    const request = requestOf({ setResponseHeader: (name, value) => void headers.push([name, value]) });
    await expect(createAssistantThreadClearRoute({ threads: () => createMemoryAssistantThreadStore({ failOn: 'commit' }), logger: () => undefined }).handler(request)).rejects.toThrow('could not be cleared');
    expect(headers).toEqual([[ASSISTANT_CLEAR_OUTCOME_HEADER, ASSISTANT_CLEAR_OUTCOME_UNKNOWN]]);
    headers.length = 0;
    await expect(createAssistantThreadClearRoute({ threads: () => createMemoryAssistantThreadStore({ failOn: 'clear' }), logger: () => undefined }).handler(request)).rejects.toThrow('could not be cleared');
    expect(headers).toEqual([]);
  });
});
