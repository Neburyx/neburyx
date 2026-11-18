import { ASK_CONTINUE_LIFETIME_MS, ExtensionRefusal, type AskAnswer } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { afterAll } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { BODY, answerOf, fileQueryResult, heavyResult, offerOf, okResult, refusalOf, rig, routeAsk, sign, type Rig } from '../testing/assistant-rig.js';
import { issueContinueToken } from '../questions/continue-token.js';

afterAll(removeAskFolders);

const PATTERN = offerOf('22222222-2222-4222-8222-222222222222', 'SECRET-PATTERN-NAME');
const SHARED = routeAsk('shared', { id: 'A-1' });
const askOf = (answer: Awaited<ReturnType<typeof answerOf>>): AskAnswer => {
  if (answer.status !== 'answered' || answer.route !== 'ask') throw new Error(`not an ask answer: ${answer.status}`);
  return answer.answer;
};
const eventOfAction = (events: Rig['events'], action: string) => events.find((event) => event.action === action);

describe('the ask route: a template intent', () => {
  it('binds and runs the intent through the gate once, and answers Ask’s result with its cited summary', async () => {
    const { route, request, runs, events, fixture } = await rig({ reply: SHARED });
    const sent = await answerOf(route.handler(request()));
    const answer = askOf(sent);
    expect(fixture.calls).toHaveLength(1);
    expect(runs).toEqual([{ asked: { templateId: 'shared-attribute', params: expect.anything() }, options: undefined, mask: false }]);
    expect('answered' in answer && answer.answered.outcome).toBe('complete');
    expect('answered' in answer && answer.answered.summary).toBeDefined();
    expect('answered' in answer && answer.answered.continueToken).toBeUndefined();
    expect(sent).toMatchObject({ step: { intent: 'shared', rows: 2, outcome: 'complete' }, coverage: '1 match shown · exact' });
    expect(eventOfAction(events, 'assistant.ask')).toMatchObject({ result: 'success', sourceId: 'demo' });
  });

  it('passes the masking of the request to the runner', async () => {
    const { route, request, runs } = await rig({ reply: SHARED });
    await route.handler(request({ ...BODY, mask: true }));
    expect(runs[0]?.mask).toBe(true);
  });

  it('labels a page cut at the source’s limit as partial and keeps the count quality of the result', async () => {
    const partial = okResult();
    if (partial.templateId !== 'shared-attribute' || partial.result.status !== 'ok') throw new Error('fixture');
    const cut: typeof partial = { templateId: 'shared-attribute', result: { ...partial.result, count: { quality: 'lowerBound', value: 25, scope: 'test' }, notices: [] } };
    const { route, request } = await rig({ reply: SHARED, run: () => ({ status: 'ok', result: cut }) });
    const answer = askOf(await answerOf(route.handler(request())));
    expect('answered' in answer && answer.answered.result).toMatchObject({ result: { count: { quality: 'lowerBound' } } });
  });
});

describe('the ask route: a file query and a saved pattern', () => {
  it('runs a file query of the folder and answers its rows', async () => {
    const { route, request, runs } = await rig({ reply: routeAsk('byId', { id: 'A-1' }), run: () => ({ status: 'ok', result: fileQueryResult() }) });
    const answer = askOf(await answerOf(route.handler(request())));
    expect(runs).toEqual([{ asked: { fileQuery: { intent: 'byId', values: { id: 'A-1' } } }, options: undefined, mask: false }]);
    expect('answered' in answer && answer.answered.result.templateId).toBe('file-query');
  });

  it('answers the nothing-found refusal of Ask for a file query that returns no row', async () => {
    const empty = fileQueryResult();
    if (empty.templateId !== 'file-query') throw new Error('fixture');
    const none: typeof empty = { templateId: 'file-query', result: { ...empty.result, nodes: [], edges: [] } };
    const { route, request, runs } = await rig({ reply: routeAsk('byId', { id: 'A-1' }), run: () => ({ status: 'ok', result: none }) });
    expect(askOf(await answerOf(route.handler(request())))).toMatchObject({ refused: { cause: 'nothing-found' } });
    expect(runs).toHaveLength(1);
  });

  it('runs one of the caller’s own saved patterns by the key the router names and answers with its label as data', async () => {
    const { route, request, runs, fixture } = await rig({ patterns: [PATTERN], reply: routeAsk('saved-pattern', { pattern: 'pat_1' }), run: () => ({ status: 'ok', result: okResult() }) });
    const answer = askOf(await answerOf(route.handler(request())));
    expect(fixture.calls[0]?.values).toContain('pat_1');
    expect(runs).toHaveLength(1);
    expect('answered' in answer && answer.answered.patternName).toBe('SECRET-PATTERN-NAME');
  });
});

describe('the ask route: refusals decided before any read of the source', () => {
  it('answers Ask’s unknown-intent refusal for an intent the folder does not hold, with nothing run', async () => {
    const { route, request, runs } = await rig({ reply: routeAsk('drop-everything', {}) });
    expect(askOf(await answerOf(route.handler(request())))).toMatchObject({ refused: { cause: 'unknown-intent' } });
    expect(runs).toEqual([]);
  });

  it.each([
    ['missing inputs', {}, 'missing-inputs'],
    ['extra inputs', { id: 'A-1', more: 'x' }, 'extra-inputs'],
  ])('answers Ask’s %s refusal with the names found, missing and extra, and runs nothing', async (_name, entities, cause) => {
    const { route, request, runs } = await rig({ reply: routeAsk('shared', entities) });
    expect(askOf(await answerOf(route.handler(request())))).toMatchObject({ refused: { cause, intent: 'shared' } });
    expect(runs).toEqual([]);
  });

  it('answers the no-ask-for-source refusal when the folder has nothing for the source, and runs nothing', async () => {
    const { route, request, runs } = await rig({ noFolder: true, reply: SHARED });
    expect(askOf(await answerOf(route.handler(request())))).toMatchObject({ refused: { cause: 'no-ask-for-source' } });
    expect(runs).toEqual([]);
  });

  it('refuses a message that names a second source: the entities cannot carry one and the source of the turn is the investigation’s', async () => {
    const { route, request, runs } = await rig({ reply: routeAsk('shared', { id: 'A-1', sourceId: 'other' }) });
    expect(askOf(await answerOf(route.handler(request())))).toMatchObject({ refused: { cause: 'extra-inputs' } });
    expect(runs).toEqual([]);
  });
});

describe('the ask route: values reach the source only as parameters', () => {
  it('passes a hostile value as the value of a parameter and in no other place', async () => {
    const hostile = "x' }) MATCH (n) DETACH DELETE n //";
    const { route, request, runs } = await rig({ reply: routeAsk('byId', { id: hostile }), run: () => ({ status: 'ok', result: fileQueryResult() }) });
    await route.handler(request());
    expect(runs).toEqual([{ asked: { fileQuery: { intent: 'byId', values: { id: hostile } } }, options: undefined, mask: false }]);
  });
});

describe('the ask route: a heavy stop', () => {
  it('answers the figure as a lower bound with a token and reads nothing past the threshold', async () => {
    const { route, request, runs } = await rig({ reply: SHARED, run: () => ({ status: 'ok', result: heavyResult() }) });
    const sentHeavy = await answerOf(route.handler(request()));
    const answer = askOf(sentHeavy);
    expect('answered' in answer && answer.answered.continueToken).toMatch(/\S+/);
    expect(sentHeavy).not.toHaveProperty('step');
    expect(sentHeavy).not.toHaveProperty('coverage');
    expect('answered' in answer && answer.answered.result).toMatchObject({ result: { status: 'heavy', estimate: { quality: 'lowerBound' } } });
    expect(runs).toHaveLength(1);
  });
});

describe('the ask route: failures of the gate', () => {
  it.each([
    ['QUERY_TIMEOUT', new ExtensionRefusal({ code: 'QUERY_TIMEOUT', timeoutMs: 1000 }), { kind: 'timeout' }],
    ['SOURCE_UNAVAILABLE', new ExtensionRefusal({ code: 'SOURCE_UNAVAILABLE', reason: 'unreachable' }), { kind: 'source-unavailable' }],
    ['SOURCE_BUSY', new ExtensionRefusal({ code: 'SOURCE_BUSY' }), { kind: 'busy' }],
    ['RATE_LIMITED', new ExtensionRefusal({ code: 'RATE_LIMITED', retryAfterMs: 2500 }), { kind: 'rate-limit', retryAfterSeconds: 3 }],
  ])('answers %s as unavailable, with a read started and no partial result', async (_name, failure, expected) => {
    const { route, request, events } = await rig({ reply: SHARED, runThrows: failure });
    expect(await answerOf(route.handler(request()))).toEqual({ status: 'unavailable', readStarted: true, ...expected });
    expect(eventOfAction(events, 'assistant.ask')).toMatchObject({ result: 'failed' });
  });

  it('gives a refusal that is not a retry of the person as the gate gave it', async () => {
    const { route, request } = await rig({ reply: SHARED, runThrows: new ExtensionRefusal({ code: 'QUERY_BUDGET_EXCEEDED' }) });
    expect((await refusalOf(route.handler(request())))?.code).toBe('QUERY_BUDGET_EXCEEDED');
  });

  it('gives an error that is not a refusal as it was', async () => {
    const { route, request } = await rig({ reply: SHARED, runThrows: new Error('boom') });
    await expect(route.handler(request())).rejects.toThrow('boom');
  });
});

describe('the continue of a heavy stop', () => {
  const entities = { id: 'A-1' };

  async function stopped(options: Parameters<typeof rig>[0] = {}) {
    const r = await rig({ reply: SHARED, run: (continuing) => ({ status: 'ok', result: continuing ? okResult() : heavyResult() }), ...options });
    const first = askOf(await answerOf(r.route.handler(r.request())));
    if (!('answered' in first) || first.answered.continueToken === undefined) throw new Error('no token');
    const continueBody = (over: { token?: string; entities?: Record<string, string>; intent?: string } = {}) => ({ sourceId: 'demo', investigationId: 'inv-1', viewElementKeys: [], continue: { intent: over.intent ?? 'shared', entities: over.entities ?? entities, continueToken: over.token ?? first.answered.continueToken ?? '' } });
    return { ...r, token: first.answered.continueToken, continueBody };
  }

  it('reads one bounded first page, with no router call, and answers the cited result; the token works again until it expires', async () => {
    const r = await stopped();
    const calls = r.fixture.calls.length;
    const answer = askOf(await answerOf(r.route.handler(r.request(r.continueBody()))));
    expect('answered' in answer && answer.answered.result).toMatchObject({ result: { status: 'ok' } });
    expect(r.fixture.calls).toHaveLength(calls);
    expect(r.runs.at(-1)).toMatchObject({ options: { continue: true } });
    expect(askOf(await answerOf(r.route.handler(r.request(r.continueBody()))))).toHaveProperty('answered');
    expect(eventOfAction(r.events, 'assistant.continue')).toBeDefined();
  });

  it('checks access again before the token', async () => {
    const r = await stopped();
    const denied = await rig({ reply: SHARED, readable: 'source' });
    expect((await refusalOf(denied.route.handler(denied.request(r.continueBody()))))?.code).toBe('NOT_FOUND');
    expect(denied.runs).toEqual([]);
  });

  it('answers continue-invalid and reads nothing for a token that is altered, expired, for other entities, a changed intent or the mask', async () => {
    const r = await stopped();
    const reads = r.runs.length;
    const invalid = { status: 'continue-invalid', sentence: expect.any(String) };
    expect(await answerOf(r.route.handler(r.request(r.continueBody({ token: `${r.token.slice(0, -2)}00` }))))).toMatchObject(invalid);
    expect(await answerOf(r.route.handler(r.request(r.continueBody({ entities: { id: 'A-2' } }))))).toMatchObject(invalid);
    expect(await answerOf(r.route.handler(r.request({ ...r.continueBody(), mask: true })))).toMatchObject(invalid);
    expect(await answerOf(r.route.handler(r.request(r.continueBody({ intent: 'byId' }))))).toMatchObject(invalid);
    expect(await answerOf(r.route.handler(r.request(r.continueBody({ intent: 'gone' }))))).toMatchObject(invalid);
    r.clock.now += ASK_CONTINUE_LIFETIME_MS + 1;
    expect(await answerOf(r.route.handler(r.request(r.continueBody())))).toMatchObject(invalid);
    expect(r.runs).toHaveLength(reads);
  });

  it('holds a token until the millisecond before its expiry and refuses it at the expiry', async () => {
    const r = await stopped();
    r.clock.now += ASK_CONTINUE_LIFETIME_MS - 1;
    expect((await answerOf(r.route.handler(r.request(r.continueBody())))).status).toBe('answered');
    r.clock.now += 1;
    expect((await answerOf(r.route.handler(r.request(r.continueBody())))).status).toBe('continue-invalid');
  });

  it('refuses a token issued to another person, and one issued for another investigation of the same source or for no investigation', async () => {
    const r = await stopped();
    const other = await answerOf(r.route.handler(r.request(r.continueBody(), { principalId: 'p-2' })));
    expect(other.status).toBe('continue-invalid');
    const body = r.continueBody();
    expect((await answerOf(r.route.handler(r.request({ ...body, investigationId: 'inv-2' })))).status).toBe('continue-invalid');
    const noInvestigation = issueContinueToken(sign, { principalId: 'p-1', sourceId: 'demo', intent: 'shared', definition: 'x', entities, mask: false }, r.clock.now);
    expect((await answerOf(r.route.handler(r.request(r.continueBody({ token: noInvestigation }))))).status).toBe('continue-invalid');
  });

  it('answers the failure of the read of a valid continue as unavailable, with no partial page', async () => {
    const r = await stopped({
      run: (continuing) => {
        if (continuing) throw new ExtensionRefusal({ code: 'SOURCE_BUSY' });
        return { status: 'ok', result: heavyResult() };
      },
    });
    expect(await answerOf(r.route.handler(r.request(r.continueBody())))).toEqual({ status: 'unavailable', kind: 'busy', readStarted: true });
  });

  it('works while Ask is switched off: the assistant has its own route and token', async () => {
    const r = await stopped();
    expect(r.route.url).toBe('/v1/assistant/turns');
    expect((await answerOf(r.route.handler(r.request(r.continueBody())))).status).toBe('answered');
  });

  it('refuses a body with both a message and a continue, and one with neither', async () => {
    const r = await stopped();
    const body = r.continueBody();
    const { assistantTurnRequestSchema } = await import('@neburyx/contracts');
    expect(assistantTurnRequestSchema.safeParse({ ...body, message: 'x' }).success).toBe(false);
    expect(assistantTurnRequestSchema.safeParse({ sourceId: 'demo', investigationId: 'inv-1', viewElementKeys: [] }).success).toBe(false);
  });
});
