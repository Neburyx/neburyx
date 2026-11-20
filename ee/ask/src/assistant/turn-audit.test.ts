import { createHash } from 'node:crypto';
import { ExtensionRefusal, askRunResultSchema, assistantTurnAnswerSchema, assistantTurnAuditDetailSchema, auditDetailSchema, type AskRunResult, type AssistantTurnAnswer, type AuditEvent, type ExtensionRequest } from '@neburyx/contracts';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { loadAskFolder } from '../folder/load.js';
import { capabilitiesOf, execute } from '../questions/question-routes.js';
import { BODY, answerOf, fileQueryResult, heavyResult, ok, okResult, rig, routeAsk, type Rig } from '../testing/assistant-rig.js';
import { TURN_CLOSED_ACTION, noteTurn, noteTurnStarted, withTurnAudit } from './turn-audit.js';
import { ROUTER_AUDIT_ACTION } from './router.js';

afterAll(removeAskFolders);

const SHARED = routeAsk('shared', { id: 'A-1' });
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLACEHOLDER = { status: 'not-answered', route: 'view', sentence: 'placeholder' } as const satisfies AssistantTurnAnswer;

const closing = (events: Rig['events']): AuditEvent[] => events.filter((event) => event.action === TURN_CLOSED_ACTION);

const turnOf = (events: Rig['events']) => {
  const closed = closing(events);
  expect(closed).toHaveLength(1);
  const [event] = closed;
  const detail = auditDetailSchema.parse(event?.detail);
  return { event, turn: assistantTurnAuditDetailSchema.parse('turn' in detail ? detail.turn : undefined) };
};

/** The microtasks a turn leaves behind (the queued closing event) have run once this resolves. */
const drain = async (): Promise<void> => {
  for (let step = 0; step < 10; step += 1) await Promise.resolve();
};

const run = async (r: Rig, body: unknown = BODY, over: Partial<ExtensionRequest> = {}) => {
  const result = await r.route.handler(r.request(body, over)).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await drain();
  return result;
};

const nodeOf = (sourceId: string, stableId: string) => ({ ref: { sourceId, entityType: 'widget', stableId }, display: { title: `Account ${stableId}`, type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const sharedResult = (sourceId: string, matches: readonly string[], count: { quality: 'exact' | 'lowerBound'; value: number } = { quality: 'exact', value: matches.length }): AskRunResult =>
  askRunResultSchema.parse({
    templateId: 'shared-attribute',
    result: { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: { ...count, scope: 'test' }, matchIds: matches.map((id) => nodeOf(sourceId, id).ref), nodes: [nodeOf(sourceId, 'A-1'), ...matches.map((id) => nodeOf(sourceId, id))], edges: [], notices: [], warnings: [] },
  });

const refOf = (stableId: string) => ({ sourceId: 'demo', entityType: 'widget', stableId });
const edgeOf = (from: string, to: string) => ({ ref: { sourceId: 'demo', type: 'LINKS', from: 'widget', to: 'widget', stableId: `${from}-${to}` }, from: refOf(from), to: refOf(to), type: 'LINKS', direction: 'from-to', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] });
/** Two shortest paths between the same ends: the heading and each path sentence cite the ends, so a key is cited by more than one sentence. */
const pathsResult = (): AskRunResult =>
  askRunResultSchema.parse({
    templateId: 'shortest-paths',
    result: {
      status: 'ok',
      paths: [
        { hops: 2, steps: [{ from: refOf('a'), to: refOf('m'), relationshipType: 'LINKS', evidenceRefs: [] }, { from: refOf('m'), to: refOf('z'), relationshipType: 'LINKS', evidenceRefs: [] }] },
        { hops: 2, steps: [{ from: refOf('a'), to: refOf('n'), relationshipType: 'LINKS', evidenceRefs: [] }, { from: refOf('n'), to: refOf('z'), relationshipType: 'LINKS', evidenceRefs: [] }] },
      ],
      nodes: ['a', 'm', 'n', 'z'].map((id) => nodeOf('demo', id)),
      edges: [edgeOf('a', 'm'), edgeOf('m', 'z'), edgeOf('a', 'n'), edgeOf('n', 'z')],
      capReached: false,
      partial: false,
      elapsedMs: 1,
      warnings: [],
    },
  });

const BETWEEN = { between: { parameters: ['a', 'b'], template: 'shortest-paths', settings: { ends: [{ entityType: 'widget', stableId: '$a' }, { entityType: 'widget', stableId: '$b' }], relTypes: ['LINKS'], maxHops: 3, limit: 5 } } };

const hangUntilAborted = (signal: AbortSignal, onAbort: () => Error): Promise<never> => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(onAbort())));

describe('the closing event of an answered Ask turn', () => {
  it('holds the route, the intent, the template, the keyed hash, the steps, the cited elements and the router call, and is the only closing event', async () => {
    const r = await rig({ reply: { ...SHARED, usage: { kind: 'known', inputTokens: 20, outputTokens: 10 } } });
    await run(r);
    const { event, turn } = turnOf(r.events);
    expect(event).toMatchObject({ actorId: 'p-1', actorRole: 'investigator', result: 'success', sourceId: 'demo', investigationId: 'inv-1', traceId: 'tr-1' });
    expect(turn).toMatchObject({ route: 'ask', outcome: 'answered', intent: 'shared', templateId: 'shared-attribute', steps: 1, citedElements: 2, modelCalls: 1, modelRef: 'fixture-model', promptId: 'assistant.route', promptVersion: '2', tokensIn: 20, tokensOut: 10 });
    expect(turn.paramsHash).toMatch(SHA);
    expect(turn.instructionsSha256).toBe(createHash('sha256').update(r.fixture.calls[0]?.instructions ?? '', 'utf8').digest('hex'));
    const asked = r.events.find((candidate) => candidate.action === 'assistant.ask');
    const detail = auditDetailSchema.parse(asked?.detail);
    expect('askRun' in detail && detail.askRun.paramsHash).toBe(turn.paramsHash);
    expect(r.events.filter((candidate) => candidate.action === ROUTER_AUDIT_ACTION)).toHaveLength(1);
  });

  it('counts a citation once however many sentences cite it', async () => {
    const r = await rig({ reply: routeAsk('between', { a: 'a', b: 'z' }), intents: BETWEEN, run: () => ({ status: 'ok', result: pathsResult() }) });
    const outcome = await run(r);
    const answer = 'value' in outcome ? assistantAnswerOf(outcome.value) : undefined;
    expect(answer?.sentences.length).toBeGreaterThan(1);
    const cites = answer?.sentences.flatMap((sentence) => sentence.cites) ?? [];
    expect(cites.length).toBeGreaterThan(new Set(cites).size);
    expect(turnOf(r.events).turn.citedElements).toBe(new Set(cites).size);
    expect(turnOf(r.events).turn.citedElements).toBe(answer?.citations.length);
  });

  it('leaves the count out when a complete result carries no summary', async () => {
    const r = await rig({ reply: SHARED, run: () => ({ status: 'ok', result: sharedResult('another-source', ['A-2']) }) });
    const outcome = await run(r);
    expect('value' in outcome && assistantAnswerOf(outcome.value)).toBeUndefined();
    const { event, turn } = turnOf(r.events);
    expect(event?.result).toBe('success');
    expect(turn).toMatchObject({ outcome: 'answered', steps: 1 });
    expect(turn).not.toHaveProperty('citedElements');
  });

  it('leaves the template out for a file query, keeping its intent and keyed hash', async () => {
    const r = await rig({ reply: routeAsk('byId', { id: 'A-1' }), run: () => ({ status: 'ok', result: fileQueryResult() }) });
    await run(r);
    const { turn } = turnOf(r.events);
    expect(turn).toMatchObject({ intent: 'byId', outcome: 'answered', steps: 1 });
    expect(turn).not.toHaveProperty('templateId');
    expect(turn.paramsHash).toMatch(SHA);
  });
});

function assistantAnswerOf(value: unknown): { sentences: { cites: string[] }[]; citations: unknown[] } | undefined {
  const answer = assistantTurnAnswerSchema.parse(value);
  if (answer.status !== 'answered' || answer.route !== 'ask' || !('answer' in answer) || !('answered' in answer.answer)) return undefined;
  return answer.answer.answered.summary;
}

describe('the closing event of the other outcomes', () => {
  it.each(['verdict', 'raw-query', 'other-source', 'unplaced'] as const)('closes a refusal of the router with the cause %s as refused, with the call, no read and no citation', async (cause) => {
    const r = await rig({ reply: ok(JSON.stringify({ route: 'refuse', cause })) });
    await run(r);
    const { event, turn } = turnOf(r.events);
    expect(event?.result).toBe('refused');
    expect(turn).toMatchObject({ route: 'refuse', outcome: 'refused', cause, steps: 0, modelCalls: 1 });
    expect(turn).not.toHaveProperty('citedElements');
  });

  it('closes a provider answer that is not a route as refused (unplaced)', async () => {
    const r = await rig({ reply: ok('nonsense') });
    await run(r);
    expect(turnOf(r.events).turn).toMatchObject({ outcome: 'refused', cause: 'unplaced', modelCalls: 1, steps: 0 });
  });

  it.each([
    ['timeout', 'timeout'],
    ['unreachable', 'service'],
    ['rejected', 'service'],
    ['rate-limited', 'rate-limit'],
    ['provider-error', 'service'],
    ['bad-reply', 'service'],
    ['truncated', 'service'],
  ] as const)('closes the provider failure %s as failed with the kind %s and unknown tokens, and no route', async (code, kind) => {
    const r = await rig({ reply: { kind: 'failed', code } });
    await run(r);
    const { event, turn } = turnOf(r.events);
    expect(event?.result).toBe('failed');
    expect(turn).toMatchObject({ outcome: 'failed', failureKind: kind, modelCalls: 1, tokensIn: 'unknown', tokensOut: 'unknown' });
    expect(turn).not.toHaveProperty('route');
  });

  it('closes a refusal of the provider as failed, keeping the configured model', async () => {
    const r = await rig({ reply: { kind: 'refused' } });
    await run(r);
    expect(turnOf(r.events).turn).toMatchObject({ outcome: 'failed', modelRef: 'configured-model', modelCalls: 1 });
  });

  it.each([
    ['an unknown intent', { reply: routeAsk('nothing-like-it', { id: 'A-1' }) }, 'unknown-intent'],
    ['missing inputs', { reply: routeAsk('shared', {}) }, 'missing-inputs'],
    ['extra inputs', { reply: routeAsk('shared', { id: 'A-1', more: 'x' }) }, 'extra-inputs'],
    ['a source with no Ask folder', { reply: SHARED, noFolder: true }, 'no-ask-for-source'],
    ['a result that lists nothing', { reply: routeAsk('byId', { id: 'A-9' }), run: () => ({ status: 'ok', result: askRunResultSchema.parse({ templateId: 'file-query', result: { status: 'ok', intent: 'byId', count: { quality: 'exact', value: 0, scope: 'rows' }, nodes: [], edges: [], notices: [], warnings: [] } }) }) as const }, 'nothing-found'],
  ])('closes %s as refused by Ask with the cause %s and a route of ask', async (_name, options, cause) => {
    const r = await rig(options);
    await run(r);
    const { event, turn } = turnOf(r.events);
    expect(event?.result).toBe('refused');
    expect(turn).toMatchObject({ route: 'ask', outcome: 'refused', cause });
    expect(turn).not.toHaveProperty('citedElements');
  });

  it('closes an over-long message, a message too large and a bad continue as refused with no model call and no router event', async () => {
    const long = await rig({ maxMessageWords: 2 });
    await run(long, { ...BODY, message: 'one two three' });
    expect(turnOf(long.events).turn).toEqual({ outcome: 'refused', cause: 'too-long', steps: 0, modelCalls: 0, runId: expect.stringMatching(UUID) });
    const large = await rig({ maxInputTokens: 10 });
    await run(large);
    expect(turnOf(large.events).turn).toEqual({ outcome: 'refused', cause: 'too-large', steps: 0, modelCalls: 0, runId: expect.stringMatching(UUID) });
    const bad = await rig();
    await run(bad, { sourceId: 'demo', investigationId: 'inv-1', viewElementKeys: [], continue: { intent: 'shared', entities: { id: 'A-1' }, continueToken: `1.${'a'.repeat(64)}` } });
    expect(turnOf(bad.events).turn).toEqual({ outcome: 'refused', cause: 'continue-invalid', steps: 0, modelCalls: 0, runId: expect.stringMatching(UUID) });
    for (const r of [long, large, bad]) expect(r.events.filter((event) => event.action === ROUTER_AUDIT_ACTION)).toHaveLength(0);
  });

  it('closes the placeholder view answer as refused, and an accepted view answer noted by the route as answered with its cited count', async () => {
    const r = await rig({ reply: ok('{"route":"view"}') });
    await run(r);
    expect(turnOf(r.events).turn).toMatchObject({ route: 'view', outcome: 'refused', cause: 'not-answered' });
    const accepted = await rig();
    const wrapped = withTurnAudit(
      { logger: () => undefined },
      async () => {
        await noteTurnStarted({ sourceId: 'demo', investigationId: 'inv-1' });
        noteTurn({ route: 'view', answered: true, citedElements: 3 });
        return PLACEHOLDER;
      },
    );
    await wrapped(accepted.request());
    await drain();
    const { event, turn } = turnOf(accepted.events);
    expect(event?.result).toBe('success');
    expect(turn).toMatchObject({ route: 'view', outcome: 'answered', citedElements: 3 });
    expect(turn).not.toHaveProperty('cause');
  });

  it.each([
    ['QUERY_TIMEOUT', new ExtensionRefusal({ code: 'QUERY_TIMEOUT', timeoutMs: 1000 })],
    ['SOURCE_UNAVAILABLE', new ExtensionRefusal({ code: 'SOURCE_UNAVAILABLE', reason: 'unreachable' })],
    ['SOURCE_BUSY', new ExtensionRefusal({ code: 'SOURCE_BUSY' })],
    ['RATE_LIMITED', new ExtensionRefusal({ code: 'RATE_LIMITED', retryAfterMs: 2500 })],
    ['QUERY_BUDGET_EXCEEDED', new ExtensionRefusal({ code: 'QUERY_BUDGET_EXCEEDED' })],
  ])('closes the read failure %s as failed, with the route and the read that started', async (_name, error) => {
    const r = await rig({ reply: SHARED, runThrows: error });
    await run(r);
    const { event, turn } = turnOf(r.events);
    expect(event?.result).toBe('failed');
    expect(turn).toMatchObject({ route: 'ask', outcome: 'failed', intent: 'shared', steps: 1, modelCalls: 1 });
    expect(turn.failureKind).toBeDefined();
    expect(turn.paramsHash).toMatch(SHA);
  });

  it('closes an error that is not a refusal as failed (internal), with the route, and rethrows it as it was', async () => {
    const r = await rig({ reply: SHARED, runThrows: new Error('boom') });
    expect(await run(r)).toMatchObject({ error: { message: 'boom' } });
    expect(turnOf(r.events).turn).toMatchObject({ route: 'ask', outcome: 'failed', failureKind: 'internal' });
  });

  it('closes a turn whose model call is pending when the request is aborted as cancelled, with the call that was noted at its start', async () => {
    const r = await rig({ reply: SHARED });
    const controller = new AbortController();
    Object.assign(r.fixture, { complete: (_request: unknown, signal: AbortSignal) => hangUntilAborted(signal, () => new Error('aborted')) });
    const pending = run(r, BODY, { signal: controller.signal });
    await vi.waitFor(() => expect(r.reads).toContain('investigation'));
    controller.abort();
    await pending;
    const { event, turn } = turnOf(r.events);
    expect(event?.result).toBe('failed');
    expect(turn).toMatchObject({ outcome: 'cancelled', failureKind: 'cancelled', modelCalls: 1, promptId: 'assistant.route', modelRef: 'configured-model', tokensIn: 'unknown' });
  });

  it('closes a turn whose read is pending when the request is aborted as cancelled, with the route, the intent and the hash', async () => {
    const controller = new AbortController();
    const r = await rig({ reply: SHARED, run: () => hangUntilAborted(controller.signal, () => new ExtensionRefusal({ code: 'QUERY_TIMEOUT', timeoutMs: 1 })) });
    const pending = run(r, BODY, { signal: controller.signal });
    await vi.waitFor(() => expect(r.runs).toHaveLength(1));
    controller.abort();
    await pending;
    const { turn } = turnOf(r.events);
    expect(turn).toMatchObject({ route: 'ask', outcome: 'cancelled', failureKind: 'cancelled', intent: 'shared', steps: 1 });
    expect(turn.paramsHash).toMatch(SHA);
  });

  it('closes a turn as cancelled, not answered, when a pending call or read still returns its result after the abort', async () => {
    const controller = new AbortController();
    const r = await rig({ reply: SHARED, run: () => new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve({ status: 'ok', result: okResult() }))) });
    const pending = run(r, BODY, { signal: controller.signal });
    await vi.waitFor(() => expect(r.runs).toHaveLength(1));
    controller.abort();
    await pending;
    const { event, turn } = turnOf(r.events);
    expect(event?.result).toBe('failed');
    expect(turn).toMatchObject({ route: 'ask', outcome: 'cancelled', intent: 'shared', steps: 1, modelCalls: 1 });
  });

  it('starts no read and writes no run event when the router answers after the client has cancelled', async () => {
    const controller = new AbortController();
    const r = await rig({ reply: SHARED });
    const answer = r.fixture.complete.bind(r.fixture);
    Object.assign(r.fixture, {
      complete: (request: Parameters<typeof answer>[0], signal: AbortSignal) => {
        controller.abort();
        return answer(request, signal);
      },
    });
    expect(await run(r, BODY, { signal: controller.signal })).toMatchObject({ error: expect.any(Error) });
    expect(r.runs).toHaveLength(0);
    expect(r.events.some((event) => event.action === 'assistant.ask')).toBe(false);
    const { event, turn } = turnOf(r.events);
    expect(event?.result).toBe('failed');
    expect(turn).toMatchObject({ outcome: 'cancelled', failureKind: 'cancelled', modelCalls: 1, steps: 0 });
  });

  it('starts no read for a continue the client has cancelled before its read begins', async () => {
    const controller = new AbortController();
    const r = await rig({ reply: SHARED, run: (continuing) => ({ status: 'ok', result: continuing ? okResult() : heavyResult() }) });
    const first = await answerOf(r.route.handler(r.request()));
    const token = first.status === 'answered' && first.route === 'ask' && 'answer' in first && 'answered' in first.answer ? first.answer.answered.continueToken : undefined;
    r.events.length = 0;
    r.runs.length = 0;
    const body = { sourceId: 'demo', investigationId: 'inv-1', viewElementKeys: [], continue: { intent: 'shared', entities: { id: 'A-1' }, continueToken: token } };
    const cancelling = async () => controller.abort();
    expect(await run(r, body, { signal: controller.signal, investigationReadable: cancelling })).toMatchObject({ error: expect.any(Error) });
    expect(r.runs).toHaveLength(0);
    expect(r.events.some((event) => event.action === 'assistant.continue')).toBe(false);
    expect(turnOf(r.events).turn).toMatchObject({ outcome: 'cancelled', modelCalls: 0 });
  });

  it('closes a continue whose read is pending when the request is aborted as cancelled, once', async () => {
    const controller = new AbortController();
    let pending = false;
    const r = await rig({ reply: SHARED, run: (continuing) => (continuing ? (pending = true, hangUntilAborted(controller.signal, () => new ExtensionRefusal({ code: 'QUERY_TIMEOUT', timeoutMs: 1 }))) : { status: 'ok', result: heavyResult() }) });
    const first = await answerOf(r.route.handler(r.request()));
    const token = first.status === 'answered' && first.route === 'ask' && 'answer' in first && 'answered' in first.answer ? first.answer.answered.continueToken : undefined;
    r.events.length = 0;
    const body = { sourceId: 'demo', investigationId: 'inv-1', viewElementKeys: [], continue: { intent: 'shared', entities: { id: 'A-1' }, continueToken: token } };
    const waiting = run(r, body, { signal: controller.signal });
    await vi.waitFor(() => expect(pending).toBe(true));
    controller.abort();
    await waiting;
    const { event, turn } = turnOf(r.events);
    expect(event?.result).toBe('failed');
    expect(turn).toMatchObject({ route: 'ask', outcome: 'cancelled', failureKind: 'cancelled', steps: 1, modelCalls: 0 });
  });

  it('closes a turn as the answer left it when the request is aborted while the closing event is being written', async () => {
    const controller = new AbortController();
    const r = await rig({ reply: SHARED });
    const audit: ExtensionRequest['audit'] = {
      record: (event) => {
        r.events.push(event);
        if (event.action === TURN_CLOSED_ACTION) controller.abort();
        return Promise.resolve();
      },
    };
    await run(r, BODY, { signal: controller.signal, audit });
    const { event, turn } = turnOf(r.events);
    expect(event?.result).toBe('success');
    expect(turn).toMatchObject({ route: 'ask', outcome: 'answered', steps: 1 });
  });

  it('closes a partial result and a heavy stop as partial', async () => {
    const heavy = await rig({ reply: SHARED, run: () => ({ status: 'ok', result: heavyResult() }) });
    await run(heavy);
    const stopped = turnOf(heavy.events);
    expect(stopped.event?.result).toBe('partial');
    expect(stopped.turn).toMatchObject({ outcome: 'answered', modelCalls: 1 });
    expect(stopped.turn).not.toHaveProperty('citedElements');
    const cut = await rig({ reply: SHARED, run: () => ({ status: 'ok', result: sharedResult('demo', ['A-2'], { quality: 'lowerBound', value: 25 }) }) });
    await run(cut);
    const partial = turnOf(cut.events);
    expect(partial.event?.result).toBe('partial');
    expect(partial.turn).toMatchObject({ outcome: 'answered', citedElements: 2 });
  });

  it('closes the continue of a heavy stop as a turn with no model call and a read of its own', async () => {
    const r = await rig({ reply: SHARED, run: (continuing) => ({ status: 'ok', result: continuing ? okResult() : heavyResult() }) });
    const first = await answerOf(r.route.handler(r.request()));
    const token = first.status === 'answered' && first.route === 'ask' && 'answer' in first && 'answered' in first.answer ? first.answer.answered.continueToken : undefined;
    expect(token).toBeDefined();
    r.events.length = 0;
    await run(r, { sourceId: 'demo', investigationId: 'inv-1', viewElementKeys: [], continue: { intent: 'shared', entities: { id: 'A-1' }, continueToken: token } });
    const { event, turn } = turnOf(r.events);
    expect(event?.result).toBe('success');
    expect(turn).toMatchObject({ route: 'ask', outcome: 'answered', intent: 'shared', steps: 1, modelCalls: 0 });
    expect(turn).not.toHaveProperty('modelRef');
  });

  it('writes no closing event for a person who may not read the source or the investigation, nor for an empty message', async () => {
    for (const readable of ['source', 'investigation'] as const) {
      const r = await rig({ readable });
      await run(r);
      expect(closing(r.events)).toHaveLength(0);
    }
    const empty = await rig();
    await run(empty, { ...BODY, message: '   ' });
    expect(closing(empty.events)).toHaveLength(0);
  });
});

describe('turns that overlap', () => {
  const standalone = async (r: Rig) => {
    const loaded = await loadAskFolder({ folder: makeAskFolder(['demo']), sourceIds: ['demo'] });
    if (!loaded.ok) throw new Error('the folder loads');
    const request = r.request();
    const before = r.events.length;
    await execute({ request, capabilities: capabilitiesOf(request), options: { folder: () => loaded.folder, runs: () => undefined, logger: () => undefined }, sourceId: 'demo', mask: false, intent: 'shared', entities: { id: 'A-1' }, continuing: false, action: 'ask.question', investigationId: 'inv-1' });
    return r.events.slice(before);
  };

  it('give each closing event only its own turn’s metadata, and leave nothing for a standalone Ask run that follows', async () => {
    const reference = await rig({ reply: SHARED });
    const baseline = await standalone(reference);
    const gate = { open: (): void => undefined };
    const opened = new Promise<void>((resolve) => (gate.open = resolve));
    const a = await rig({ reply: SHARED, run: async () => (await opened, { status: 'ok', result: okResult() }) });
    const b = await rig({ reply: ok('{"route":"refuse","cause":"verdict"}') });
    const c = await rig({ reply: routeAsk('byId', { id: 'A-1' }), runThrows: new Error('boom') });
    const d = await rig({ reply: { kind: 'failed', code: 'timeout' } });
    const pendingA = a.route.handler(a.request({ ...BODY, sourceId: 'demo', investigationId: 'inv-a' }, { principalId: 'p-a', traceId: 'tr-a' }));
    await vi.waitFor(() => expect(a.runs).toHaveLength(1));
    const second = await answerOf(b.route.handler(b.request({ ...BODY, sourceId: 'src-b', investigationId: 'inv-b' }, { principalId: 'p-b', traceId: 'tr-b' })));
    const third = await c.route.handler(c.request({ ...BODY, investigationId: 'inv-c' }, { principalId: 'p-c', traceId: 'tr-c' })).catch(() => undefined);
    const fourth = await answerOf(d.route.handler(d.request({ ...BODY, sourceId: 'src-d', investigationId: 'inv-d' }, { principalId: 'p-d', traceId: 'tr-d' })));
    gate.open();
    const first = await answerOf(pendingA);
    await drain();
    expect([first.status, second.status, third, fourth.status]).toEqual(['answered', 'answered', undefined, 'unavailable']);
    expect(turnOf(a.events)).toMatchObject({ event: { actorId: 'p-a', traceId: 'tr-a', sourceId: 'demo', investigationId: 'inv-a' }, turn: { route: 'ask', intent: 'shared', outcome: 'answered' } });
    expect(turnOf(b.events)).toMatchObject({ event: { actorId: 'p-b', traceId: 'tr-b', sourceId: 'src-b', investigationId: 'inv-b' }, turn: { route: 'refuse', outcome: 'refused', modelCalls: 1 } });
    expect(turnOf(c.events)).toMatchObject({ event: { actorId: 'p-c', traceId: 'tr-c', sourceId: 'demo', investigationId: 'inv-c' }, turn: { route: 'ask', outcome: 'failed', failureKind: 'internal', intent: 'byId' } });
    expect(turnOf(d.events)).toMatchObject({ event: { actorId: 'p-d', traceId: 'tr-d', sourceId: 'src-d', investigationId: 'inv-d' }, turn: { outcome: 'failed', failureKind: 'timeout', modelCalls: 1 } });
    for (const event of [b, d].map((r) => turnOf(r.events).turn)) {
      expect(event).not.toHaveProperty('intent');
      expect(event).not.toHaveProperty('paramsHash');
    }
    expect(turnOf(c.events).turn).not.toHaveProperty('templateId');
    const later = await standalone(await rig({ reply: SHARED }));
    expect(later).toEqual(baseline);
    expect(closing(later)).toHaveLength(0);
    expect(JSON.stringify(later)).not.toContain('citedElements');
  });

  it('leave nothing for the turn that follows, and notes made outside a turn change nothing', async () => {
    const r = await rig({ reply: SHARED });
    await run(r);
    noteTurn({ route: 'view', answered: true, citedElements: 9, cause: 'leaked' });
    await noteTurnStarted({ sourceId: 'leaked', investigationId: 'leaked' });
    const next = await rig({ reply: ok('{"route":"refuse","cause":"verdict"}') });
    await run(next);
    expect(turnOf(next.events).turn).toEqual({ route: 'refuse', outcome: 'refused', cause: 'verdict', steps: 0, modelCalls: 1, modelRef: 'fixture-model', promptId: 'assistant.route', promptVersion: '2', instructionsSha256: expect.stringMatching(SHA), tokensIn: 20, tokensOut: 10, runId: expect.stringMatching(UUID) });
    expect(closing(next.events)[0]).toMatchObject({ sourceId: 'demo', investigationId: 'inv-1' });
    expect(closing(r.events)).toHaveLength(1);
  });
});

describe('the closing event that cannot be built or written', () => {
  it('leaves the answer as it was and logs the ids of the turn only, when the event cannot be built', async () => {
    const r = await rig();
    const logs: Record<string, unknown>[] = [];
    const broken = Object.defineProperty({ ...PLACEHOLDER }, 'status', {
      get: (): never => {
        throw new Error('SENTINEL-TEXT');
      },
    });
    const wrapped = withTurnAudit(
      { logger: () => ({ warn: (fields) => void logs.push(fields) }) },
      async () => {
        await noteTurnStarted({ sourceId: 'demo', investigationId: 'inv-1' });
        return broken;
      },
    );
    expect(await wrapped(r.request())).toBe(broken);
    await drain();
    expect(closing(r.events)).toHaveLength(0);
    expect(logs).toEqual([{ event: 'assistant-turn-event-not-built', action: TURN_CLOSED_ACTION, traceId: 'tr-1' }]);
  });

  it('tells the audit member of the application, by ids only, that the event could not be built, and does not log it twice', async () => {
    const r = await rig();
    const failed: AuditEvent[] = [];
    const logs: Record<string, unknown>[] = [];
    const wrapped = withTurnAudit(
      { logger: () => ({ warn: (fields) => void logs.push(fields) }) },
      async () => {
        await noteTurnStarted({ sourceId: 'demo', investigationId: 'inv-1' });
        noteTurn({ route: 'view', cause: 'a sentence that is text, not a code' });
        return PLACEHOLDER;
      },
    );
    expect(await wrapped({ ...r.request(), audit: { record: () => Promise.resolve(), failed: (event) => void failed.push(event) } })).toBe(PLACEHOLDER);
    expect(failed).toEqual([{ actorId: 'p-1', actorRole: 'investigator', action: TURN_CLOSED_ACTION, result: 'failed', sourceId: 'demo', investigationId: 'inv-1', traceId: 'tr-1' }]);
    expect(logs).toHaveLength(0);
  });

  it('queues no event for a detail that holds text, answers as before and logs the ids only', async () => {
    const r = await rig();
    const logs: Record<string, unknown>[] = [];
    const wrapped = withTurnAudit(
      { logger: () => ({ warn: (fields) => void logs.push(fields) }) },
      async () => {
        await noteTurnStarted({ sourceId: 'demo', investigationId: 'inv-1' });
        noteTurn({ route: 'view', cause: 'a sentence that is text, not a code' });
        return PLACEHOLDER;
      },
    );
    expect(await wrapped(r.request())).toBe(PLACEHOLDER);
    await drain();
    expect(closing(r.events)).toHaveLength(0);
    expect(JSON.stringify(logs)).not.toContain('sentence');
    expect(logs).toHaveLength(1);
  });

  it('leaves the answer and the failure as they were when the closing event is thrown, rejected or never answered', async () => {
    const bad: ((event: AuditEvent) => Promise<void>)[] = [
      () => {
        throw new Error('down');
      },
      () => Promise.reject(new Error('down')),
      () => new Promise<void>(() => undefined),
    ];
    for (const fail of bad) {
      const audit = { record: (event: AuditEvent) => (event.action === TURN_CLOSED_ACTION ? fail(event) : Promise.resolve()) };
      const r = await rig({ reply: SHARED });
      expect(await r.route.handler({ ...r.request(), audit })).toMatchObject({ status: 'answered', route: 'ask' });
      const failing = await rig({ reply: SHARED, runThrows: new Error('boom') });
      await expect(failing.route.handler({ ...failing.request(), audit })).rejects.toThrow('boom');
    }
  });
});
