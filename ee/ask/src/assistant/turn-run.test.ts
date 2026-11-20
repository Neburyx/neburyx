import { ExtensionRefusal, askRunResultSchema, auditDetailSchema, type AuditEvent, type ExtensionRequest } from '@neburyx/contracts';
import { promptRecordOf, type ModelAnswer } from '@neburyx/ee-ai-runtime';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { BODY, MESSAGE, answerOf, ok, okResult, rig, routeAsk, type Rig, type RigOptions } from '../testing/assistant-rig.js';
import { createMemoryAssistantRunStore, type AssistantRunStore } from './run-store.js';
import { readAssistantSettings } from './settings.js';
import { loadAskFolder } from '../folder/load.js';
import { makeAskFolder } from '../testing/ask-folder.js';
import { createAskQuestionRoute } from '../questions/question-routes.js';
import { TURN_CLOSED_ACTION, noteTurn, noteTurnStarted, withTurnAudit } from './turn-audit.js';

afterAll(removeAskFolders);

const SHARED = routeAsk('shared', { id: 'A-1' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVESTIGATION = '01939999-0000-7000-8000-0000000000aa';
const PLACEHOLDER = { status: 'not-answered', route: 'view', sentence: 'placeholder' } as const;

type Memory = ReturnType<typeof createMemoryAssistantRunStore>;
type Order = string[];

/** The memory store with every write noted in `order`, so the order of the writes, the provider's request and the events can be read. */
function ordered(order: Order, failOn?: Parameters<typeof createMemoryAssistantRunStore>[0] extends infer O ? (O extends { failOn?: infer F } ? F : never) : never): Memory {
  const store = createMemoryAssistantRunStore(failOn === undefined ? {} : { failOn });
  return {
    ...store,
    begin: (run) => (order.push('begin'), store.begin(run)),
    beginCall: (call) => (order.push('beginCall'), store.beginCall(call)),
    endCall: (call) => (order.push('endCall'), store.endCall(call)),
    finish: (runId, outcome, calls, at) => (order.push('finish'), store.finish(runId, outcome, calls, at)),
  };
}

const drain = async (): Promise<void> => {
  for (let step = 0; step < 10; step += 1) await Promise.resolve();
};

interface Turn {
  readonly r: Rig;
  readonly store: Memory;
  readonly order: Order;
}

async function turnRig(options: RigOptions = {}, failOn?: Parameters<typeof ordered>[1]): Promise<Turn> {
  const order: Order = [];
  const store = ordered(order, failOn);
  const r = await rig({ ...options, runStore: store });
  Object.assign(r.fixture, { complete: ((complete) => async (request: Parameters<typeof complete>[0], signal: AbortSignal) => (order.push('provider'), complete(request, signal)))(r.fixture.complete.bind(r.fixture)) });
  return { r, store, order };
}

const run = async (turn: Turn, body: unknown = BODY, over: Partial<ExtensionRequest> = {}) => {
  const request = turn.r.request(body, over);
  const audit = { record: (event: AuditEvent) => (turn.order.push(`event:${event.action}`), turn.r.events.push(event), Promise.resolve()) };
  const result = await turn.r.route.handler({ ...request, audit }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await drain();
  return result;
};

const eventsOf = (turn: Turn, action: string) => turn.r.events.filter((event) => event.action === action);
const detailOf = (event: AuditEvent | undefined) => auditDetailSchema.parse(event?.detail);

describe('the run and call records of an answered turn', () => {
  it('holds the run, and a call with the exact instructions, values and reply, the tokens and the duration', async () => {
    const turn = await turnRig({ reply: { ...SHARED, usage: { kind: 'known', inputTokens: 20, outputTokens: 10 } } });
    Object.assign(turn.r.fixture, { complete: ((complete) => async (request: Parameters<typeof complete>[0], signal: AbortSignal) => ((turn.r.clock.now += 40), complete(request, signal)))(turn.r.fixture.complete.bind(turn.r.fixture)) });
    await run(turn, { ...BODY, investigationId: INVESTIGATION });
    const [recorded] = turn.store.runs;
    expect(turn.store.runs).toHaveLength(1);
    expect(recorded?.start).toMatchObject({ id: expect.stringMatching(UUID), actorId: 'p-1', investigationId: INVESTIGATION, sourceId: 'demo', traceId: 'tr-1', settings: { model: 'claude-sonnet-5-5', maxCalls: 5 } });
    expect(recorded).toMatchObject({ outcome: 'answered', calls: 1 });
    const [sent] = turn.r.fixture.calls;
    expect(recorded?.callStarts).toEqual([expect.objectContaining({ number: 1, instructionsText: sent?.instructions, valuesText: sent?.values, instructionsSha256: promptRecordOf(sent ?? { promptId: '', version: 0, values: '' }).sha256 })]);
    expect(recorded?.callStarts[0]?.valuesText).toContain(MESSAGE);
    expect(recorded?.callEnds).toEqual([{ runId: recorded?.id, number: 1, status: 'answered', replyText: JSON.stringify({ route: 'ask', intent: 'shared', entities: { id: 'A-1' } }), tokensIn: 20, tokensOut: 10, durationMs: 40 }]);
  });

  it('stores the whole of the settings in force in the run row, with values that are not the defaults', async () => {
    const env = { NEBURYX_ASSISTANT_MAX_MESSAGE_WORDS: '2', NEBURYX_ASSISTANT_MAX_STEPS: '2', NEBURYX_ASSISTANT_MAX_ROWS: '7', NEBURYX_ASSISTANT_CONTEXT_TURNS: '5', NEBURYX_ASSISTANT_RUN_RETENTION_DAYS: '9', NEBURYX_ASSISTANT_MODEL: 'claude-haiku-5-5' };
    const read = readAssistantSettings(env);
    const turn = await turnRig({ maxMessageWords: 2, settingsEnv: env });
    await run(turn, { ...BODY, message: 'one two three' });
    expect(read.ok && turn.store.runs[0]?.start.settings).toEqual(read.ok ? read.settings : undefined);
    expect(turn.store.runs[0]?.start.settings).toMatchObject({ maxMessageWords: 2, maxSteps: 2, maxRows: 7, contextTurns: 5, runRetentionDays: 9, model: 'claude-haiku-5-5' });
    expect(turn.store.runs[0]).toMatchObject({ outcome: 'refused', calls: 0 });
  });

  it('leaves an investigation that is not a UUID out of the run row', async () => {
    const turn = await turnRig({ reply: ok('{"route":"view"}') });
    await run(turn);
    expect(turn.store.runs[0]?.start).not.toHaveProperty('investigationId');
  });

  it('queues the run and the call start before the provider is asked, and the call end and the finish before the closing event', async () => {
    const turn = await turnRig({ reply: SHARED });
    await run(turn);
    const { order } = turn;
    expect(order.indexOf('begin')).toBeLessThan(order.indexOf('beginCall'));
    expect(order.indexOf('beginCall')).toBeLessThan(order.indexOf('provider'));
    expect(order.indexOf('provider')).toBeLessThan(order.indexOf('endCall'));
    expect(order.indexOf('endCall')).toBeLessThan(order.indexOf('finish'));
    expect(order.indexOf('finish')).toBeLessThan(order.indexOf(`event:${TURN_CLOSED_ACTION}`));
  });

  it('puts the same run id in the model call event, the Ask event and the closing event of a turn, and in no other', async () => {
    const turn = await turnRig({ reply: SHARED });
    await run(turn);
    const id = turn.store.runs[0]?.id;
    const route = detailOf(eventsOf(turn, 'assistant.route')[0]);
    const asked = detailOf(eventsOf(turn, 'assistant.ask')[0]);
    const closed = detailOf(eventsOf(turn, TURN_CLOSED_ACTION)[0]);
    expect('ai' in route && route.ai.runId).toBe(id);
    expect('askRun' in asked && asked.askRun.runId).toBe(id);
    expect('turn' in closed && closed.turn.runId).toBe(id);
    expect(turn.r.events.filter((event) => !['assistant.route', 'assistant.ask', TURN_CLOSED_ACTION].includes(event.action))).toEqual([]);
  });

  it('has no Ask event on the refuse and view routes, no model call event on a continue, and the run id in each event that is written', async () => {
    const refused = await turnRig({ reply: ok('{"route":"refuse","cause":"verdict"}') });
    await run(refused);
    expect(eventsOf(refused, 'assistant.ask')).toEqual([]);
    expect(eventsOf(refused, TURN_CLOSED_ACTION)).toHaveLength(1);
    const view = await turnRig({ reply: ok('{"route":"view"}') });
    await run(view);
    expect(eventsOf(view, 'assistant.ask')).toEqual([]);
    const id = view.store.runs[0]?.id;
    for (const event of view.r.events) {
      const detail = detailOf(event);
      expect(('ai' in detail && detail.ai.runId) || ('turn' in detail && detail.turn.runId)).toBe(id);
    }
  });

  it('records nothing and carries no run id when the person may not read the source or the investigation, or the message is empty', async () => {
    for (const readable of ['source', 'investigation'] as const) {
      const turn = await turnRig({ readable });
      await run(turn);
      expect(turn.store.runs).toEqual([]);
      expect(turn.r.events).toEqual([]);
    }
    const empty = await turnRig();
    await run(empty, { ...BODY, message: '  ' });
    expect(empty.store.runs).toEqual([]);
    expect(empty.r.events).toEqual([]);
  });
});

describe('the records of the other ends of a turn', () => {
  it.each([
    ['timeout', 'timeout'],
    ['unreachable', 'unreachable'],
    ['rejected', 'rejected'],
    ['rate-limited', 'rate-limited'],
    ['provider-error', 'provider-error'],
    ['bad-reply', 'bad-reply'],
    ['truncated', 'truncated'],
  ] as const)('ends the call as failed with the kind %s and no reply text the provider did not give', async (code, kind) => {
    const turn = await turnRig({ reply: { kind: 'failed', code } });
    await run(turn);
    const [recorded] = turn.store.runs;
    expect(recorded).toMatchObject({ outcome: 'failed', calls: 1 });
    expect(recorded?.callEnds[0]).toMatchObject({ status: 'failed', failureKind: kind });
    expect(recorded?.callEnds[0]).not.toHaveProperty('replyText');
  });

  it('keeps the text a failed or refused provider answer carried, and the exact text of a reply that is not a route (failed, not-a-route)', async () => {
    const turn = await turnRig();
    const failing = (request: { promptId: string; version: number; instructions?: string; values: string }): ModelAnswer => ({ status: 'failed', code: 'bad-reply', usage: { kind: 'unknown' }, prompt: promptRecordOf(request), received: 'RECEIVED-TEXT' });
    Object.assign(turn.r.fixture, { complete: async (request: Parameters<typeof failing>[0]) => failing(request) });
    await run(turn);
    expect(turn.store.runs[0]?.callEnds[0]).toMatchObject({ status: 'failed', failureKind: 'bad-reply', replyText: 'RECEIVED-TEXT' });
    const odd = await turnRig({ reply: ok('nonsense') });
    await run(odd);
    expect(odd.store.runs[0]).toMatchObject({ outcome: 'refused' });
    expect(odd.store.runs[0]?.callEnds[0]).toMatchObject({ status: 'failed', failureKind: 'not-a-route', replyText: 'nonsense' });
    const refused = await turnRig({ reply: { kind: 'refused' } });
    await run(refused);
    expect(refused.store.runs[0]?.callEnds[0]).toMatchObject({ status: 'refused' });
  });

  it('ends a call that throws as failed (unreachable), and one whose reply fails the audit after it arrived as failed (audit-unavailable) holding the reply, with the response of a turn that records nothing', async () => {
    const thrown = await turnRig();
    Object.assign(thrown.r.fixture, { complete: async () => Promise.reject(new Error('the connection broke')) });
    const withoutStore = await rig();
    Object.assign(withoutStore.fixture, { complete: async () => Promise.reject(new Error('the connection broke')) });
    expect(await answerOf(thrown.r.route.handler(thrown.r.request()))).toEqual(await answerOf(withoutStore.route.handler(withoutStore.request())));
    await drain();
    expect(thrown.store.runs[0]?.callEnds[0]).toMatchObject({ status: 'failed', failureKind: 'unreachable' });
    const other = { status: 'ok', text: 'OTHER-REPLY', usage: { kind: 'unknown' }, model: 'm', prompt: { id: 'another', version: 1, sha256: 'a'.repeat(64) } } as const satisfies ModelAnswer;
    const mismatched = await turnRig();
    Object.assign(mismatched.r.fixture, { complete: async () => other });
    const bare = await rig();
    Object.assign(bare.fixture, { complete: async () => other });
    const recorded = await mismatched.r.route.handler(mismatched.r.request()).then(() => undefined, (error: unknown) => error);
    const plain = await bare.route.handler(bare.request()).then(() => undefined, (error: unknown) => error);
    await drain();
    expect(recorded).toBeInstanceOf(ExtensionRefusal);
    expect((recorded as ExtensionRefusal).code).toBe((plain as ExtensionRefusal).code);
    expect(mismatched.store.runs[0]).toMatchObject({ outcome: 'failed' });
    expect(mismatched.store.runs[0]?.callEnds[0]).toMatchObject({ status: 'failed', failureKind: 'audit-unavailable', replyText: 'OTHER-REPLY' });
  });

  it('ends a pending call, and the run, as cancelled when the request is aborted', async () => {
    const turn = await turnRig({ reply: SHARED });
    const controller = new AbortController();
    Object.assign(turn.r.fixture, { complete: (_request: unknown, signal: AbortSignal) => (turn.order.push('provider'), new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))) });
    const pending = run(turn, BODY, { signal: controller.signal });
    await vi.waitFor(() => expect(turn.order).toContain('provider'));
    controller.abort();
    await pending;
    expect(turn.store.runs[0]).toMatchObject({ outcome: 'cancelled', calls: 1 });
    expect(turn.store.runs[0]?.callEnds[0]).toMatchObject({ status: 'cancelled' });
  });

  it('ends a call whose provider answers well after the abort as cancelled, keeping the reply it returned', async () => {
    const controller = new AbortController();
    const turn = await turnRig({ reply: SHARED });
    Object.assign(turn.r.fixture, {
      complete: (request: { promptId: string; version: number; instructions?: string; values: string }, signal: AbortSignal) => (
        turn.order.push('provider'),
        new Promise<ModelAnswer>((resolve) => signal.addEventListener('abort', () => resolve({ status: 'ok', text: '{"route":"view"}', usage: { kind: 'unknown' }, model: 'm', prompt: promptRecordOf(request) })))
      ),
    });
    const pending = run(turn, BODY, { signal: controller.signal });
    await vi.waitFor(() => expect(turn.order).toContain('provider'));
    controller.abort();
    await pending;
    expect(turn.store.runs[0]).toMatchObject({ outcome: 'cancelled', calls: 1 });
    expect(turn.store.runs[0]?.callEnds[0]).toMatchObject({ status: 'cancelled', replyText: '{"route":"view"}' });
  });

  it('keeps the status of a completed call when the request is aborted after it, during the read or between the router and the read, and ends the run as cancelled', async () => {
    const during = new AbortController();
    const reading = await turnRig({ reply: SHARED, run: () => new Promise((_resolve, reject) => during.signal.addEventListener('abort', () => reject(new ExtensionRefusal({ code: 'QUERY_TIMEOUT', timeoutMs: 1 })))) });
    const first = run(reading, BODY, { signal: during.signal });
    await vi.waitFor(() => expect(reading.r.runs).toHaveLength(1));
    during.abort();
    await first;
    expect(reading.store.runs[0]).toMatchObject({ outcome: 'cancelled', calls: 1 });
    expect(reading.store.runs[0]?.callEnds[0]).toMatchObject({ status: 'answered' });
    const between = new AbortController();
    const returning = await turnRig({ reply: SHARED, run: () => (between.abort(), Promise.resolve({ status: 'ok', result: okResult() })) });
    await run(returning, BODY, { signal: between.signal });
    expect(returning.store.runs[0]).toMatchObject({ outcome: 'cancelled', calls: 1 });
    expect(returning.store.runs[0]?.callEnds[0]).toMatchObject({ status: 'answered' });
  });

  it('records a run with no call and the outcome of the closing event for a message that is too long or too large, a continue and a bad continue', async () => {
    const long = await turnRig({ maxMessageWords: 2 });
    await run(long, { ...BODY, message: 'one two three' });
    expect(long.store.runs[0]).toMatchObject({ outcome: 'refused', calls: 0, callStarts: [], callEnds: [] });
    const large = await turnRig({ maxInputTokens: 10 });
    await run(large);
    expect(large.store.runs[0]).toMatchObject({ outcome: 'refused', calls: 0 });
    const bad = await turnRig();
    await run(bad, { sourceId: 'demo', investigationId: 'inv-1', viewElementKeys: [], continue: { intent: 'shared', entities: { id: 'A-1' }, continueToken: `1.${'a'.repeat(64)}` } });
    expect(bad.store.runs[0]).toMatchObject({ outcome: 'refused', calls: 0 });
    const heavy = await turnRig({ reply: SHARED, run: (continuing) => ({ status: 'ok', result: continuing ? okResult() : askRunResultSchema.parse({ templateId: 'shared-attribute', result: { status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', estimate: { quality: 'lowerBound', value: 1000, scope: 'test' }, threshold: 1000, continueLimit: 25, notices: [], warnings: [] } }) }) });
    const first = await answerOf(heavy.r.route.handler(heavy.r.request()));
    const token = first.status === 'answered' && first.route === 'ask' && 'answer' in first && 'answered' in first.answer ? first.answer.answered.continueToken : undefined;
    heavy.store.runs.length = 0;
    await run(heavy, { sourceId: 'demo', investigationId: 'inv-1', viewElementKeys: [], continue: { intent: 'shared', entities: { id: 'A-1' }, continueToken: token } });
    expect(heavy.store.runs[0]).toMatchObject({ outcome: 'answered', calls: 0 });
  });

  it('finishes the run with the turn’s outcome when the closing event cannot be built', async () => {
    const order: Order = [];
    const store = ordered(order);
    const r = await rig();
    const wrapped = withTurnAudit(
      { logger: () => undefined, runs: () => store, settings: () => undefined, now: () => 1 },
      async () => {
        await noteTurnStarted({ sourceId: 'demo', investigationId: INVESTIGATION });
        noteTurn({ route: 'view', cause: 'a sentence that is text, not a code' });
        return PLACEHOLDER;
      },
    );
    await wrapped(r.request());
    await drain();
    expect(store.runs[0]).toMatchObject({ outcome: 'refused', calls: 0 });
    expect(r.events.filter((event) => event.action === TURN_CLOSED_ACTION)).toEqual([]);
  });
});

describe('the records that cannot be written, and turns that overlap', () => {
  it.each(['begin', 'beginCall', 'endCall', 'finish'] as const)('answer a turn whose store fails at %s, and log the run and the step only', async (step) => {
    const logs: { fields: Record<string, unknown>; message: string }[] = [];
    const turn = await turnRig({ reply: SHARED, logs }, step);
    const baseline = await rig({ reply: SHARED });
    const outcome = await run(turn);
    expect('value' in outcome && outcome.value).toEqual(await answerOf(baseline.route.handler(baseline.request())));
    expect(logs.filter((line) => line.fields['step'] === step)).toEqual([{ fields: { event: 'assistant-run.not-recorded', runId: expect.stringMatching(UUID), step }, message: 'a record of an assistant turn could not be written' }]);
    expect(eventsOf(turn, TURN_CLOSED_ACTION)).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(MESSAGE);
  });

  it('does not wait for a store that never answers: the model is asked and the turn answered', async () => {
    const never = new Promise<void>(() => undefined);
    const store: AssistantRunStore = { ...createMemoryAssistantRunStore(), begin: () => never, beginCall: () => never, endCall: () => never, finish: () => never };
    const r = await rig({ reply: SHARED, runStore: store });
    expect(await answerOf(r.route.handler(r.request()))).toMatchObject({ status: 'answered', route: 'ask' });
    expect(r.fixture.calls).toHaveLength(1);
  });

  it('turns with no store built still carry a run id in their events and write nothing', async () => {
    const r = await rig({ reply: SHARED });
    await r.route.handler(r.request());
    await drain();
    const id = detailOf(r.events.find((event) => event.action === TURN_CLOSED_ACTION));
    expect('turn' in id && id.turn.runId).toMatch(UUID);
  });

  it('give each overlapping turn its own run, calls and events, and a standalone Ask run that follows no assistant record', async () => {
    const gate = { open: (): void => undefined };
    const opened = new Promise<void>((resolve) => (gate.open = resolve));
    const store = createMemoryAssistantRunStore();
    const [a, b] = await Promise.all([rig({ reply: SHARED, runStore: store, run: async () => (await opened, { status: 'ok', result: okResult() }) }), rig({ reply: ok('{"route":"refuse","cause":"verdict"}'), runStore: store })]);
    const pendingA = a.route.handler(a.request({ ...BODY, message: 'CANARY-A', sourceId: 'demo', investigationId: 'inv-a' }, { principalId: 'p-a', traceId: 'tr-a' }));
    await vi.waitFor(() => expect(a.runs).toHaveLength(1));
    await b.route.handler(b.request({ ...BODY, message: 'CANARY-B', sourceId: 'src-b', investigationId: 'inv-b' }, { principalId: 'p-b', traceId: 'tr-b' }));
    gate.open();
    await pendingA;
    await drain();
    expect(store.runs).toHaveLength(2);
    const [runA, runB] = ['tr-a', 'tr-b'].map((trace) => store.runs.find((held) => held.start.traceId === trace));
    expect(runA?.id).not.toBe(runB?.id);
    expect(runA?.callStarts[0]?.valuesText).toContain('CANARY-A');
    expect(runA?.callStarts[0]?.valuesText).not.toContain('CANARY-B');
    expect(runB?.callStarts[0]?.valuesText).toContain('CANARY-B');
    expect(runB?.callStarts[0]?.valuesText).not.toContain('CANARY-A');
    expect([runA?.start.sourceId, runB?.start.sourceId, runA?.start.actorId, runB?.start.actorId]).toEqual(['demo', 'src-b', 'p-a', 'p-b']);
    const closedA = detailOf(a.events.find((event) => event.action === TURN_CLOSED_ACTION));
    const closedB = detailOf(b.events.find((event) => event.action === TURN_CLOSED_ACTION));
    expect([('turn' in closedA && closedA.turn.runId), ('turn' in closedB && closedB.turn.runId)]).toEqual([runA?.id, runB?.id]);
    const kept = JSON.stringify(store.runs);
    const loaded = await loadAskFolder({ folder: makeAskFolder(['demo']), sourceIds: ['demo'] });
    if (!loaded.ok) throw new Error('the folder loads');
    const standalone = createAskQuestionRoute({ folder: () => loaded.folder, runs: () => undefined, logger: () => undefined });
    const asked: AuditEvent[] = [];
    const request = a.request({ sourceId: 'demo', question: 'Which accounts share a shape with A-1?' }, { audit: { record: (event) => (asked.push(event), Promise.resolve()) }, askClassifier: { availability: () => ({ available: true }), classify: async () => ({ ok: true, intent: 'shared', entities: { id: 'A-1' } }) } });
    await standalone.handler(request);
    await drain();
    expect(asked.map((event) => event.action)).toContain('ask.question');
    expect(JSON.stringify(asked)).not.toMatch(/runId/);
    expect(JSON.stringify(store.runs)).toBe(kept);
  });
});
