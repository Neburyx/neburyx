import { ASSISTANT_LIMIT_SENTENCES, ASSISTANT_REFUSAL_SENTENCES } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { BODY, VIEW_BODY, answerOf, fileQueryResult, heavyResult, ok, okResult, rig, routeAsk, type Rig } from '../testing/assistant-rig.js';
import { TURN_CLOSED_ACTION } from './turn-audit.js';
import type { FixtureReply } from '../../../ai-runtime/src/testing/fixture.js';

afterAll(removeAskFolders);

const SHARED = routeAsk('shared', { id: 'A-1' });
const DONE = ok('{"done":true}');
const byId = (id: string) => ok(JSON.stringify({ tool: 'byId', values: { id } }));
const VIEW_TOOL = ok('{"tool":"view","values":{}}');
const GOOD = ok(JSON.stringify({ sentences: [{ text: 'Account A-1 and account A-2 are listed.', cites: ['r1', 'r2'] }] }));

/** The replies of the step call in order; the last one repeats. */
const sequence = (...replies: FixtureReply[]) => {
  let next = 0;
  return () => replies[Math.min(next++, replies.length - 1)] ?? DONE;
};

const closed = (r: Rig) => r.events.filter((event) => event.action === TURN_CLOSED_ACTION);
const turnOf = (r: Rig) => (closed(r)[0]?.detail as { turn: Record<string, unknown> }).turn;
const stepCalls = (r: Rig) => r.fixture.calls.filter((call) => call.promptId === 'assistant.step');
const rowsOf = (answer: Awaited<ReturnType<typeof answerOf>>) => (answer.status === 'answered' && answer.route === 'ask' && 'answer' in answer && 'answered' in answer.answer ? answer.answer.answered : undefined);

describe('the next step after an ask read', () => {
  it.each([[1, 'A message that needs more than one read is refused with the cause `unplaced`.'], [4, 'A message that needs several reads is one `ask` reply with the intent of its first read']])('tells the router, with %s steps allowed, how a message that needs several reads is placed', async (loopSteps, line) => {
    const r = await rig({ reply: SHARED, step: sequence(DONE), loopSteps });
    await answerOf(r.route.handler(r.request()));
    const router = r.fixture.calls.find((call) => call.promptId === 'assistant.route');
    expect(router?.instructions).toContain(line);
  });

  it('makes no step call when the settings allow one step, and answers as before', async () => {
    const r = await rig({ reply: SHARED, step: sequence(DONE), loopSteps: 1 });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(stepCalls(r)).toHaveLength(0);
    expect(rowsOf(answer)?.intent).toBe('shared');
    expect(turnOf(r)).toMatchObject({ modelCalls: 1, steps: 1 });
  });

  it('makes no step call after a read Ask stops as heavy, one that finds nothing, or one the run refuses', async () => {
    const heavy = await rig({ reply: SHARED, step: sequence(DONE), run: () => ({ status: 'ok', result: heavyResult() }) });
    await answerOf(heavy.route.handler(heavy.request()));
    expect(stepCalls(heavy)).toHaveLength(0);
    const empty = await rig({ reply: SHARED, step: sequence(DONE), run: () => ({ status: 'ok', result: { templateId: 'file-query', result: { ...(fileQueryResult().templateId === 'file-query' ? fileQueryResult().result : ({} as never)), nodes: [], edges: [] } } as never }) });
    await answerOf(empty.route.handler(empty.request()));
    expect(stepCalls(empty)).toHaveLength(0);
  });

  it('answers Ask’s own deterministic reply when the model says it is done, after one step call', async () => {
    const r = await rig({ reply: SHARED, step: sequence(DONE) });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(stepCalls(r)).toHaveLength(1);
    expect(rowsOf(answer)).toMatchObject({ intent: 'shared', outcome: 'complete' });
    expect(turnOf(r)).toMatchObject({ outcome: 'answered', modelCalls: 2, steps: 1 });
  });

  it('runs a requested tool through the runner, and answers with checked sentences over what the reads returned when the model is done', async () => {
    const r = await rig({ reply: SHARED, step: sequence(byId('A-2'), DONE), answer: GOOD, run: () => ({ status: 'ok', result: okResult() }) });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(r.runs.map((run) => JSON.stringify(run.asked))).toEqual([expect.stringContaining('shared-attribute'), expect.stringContaining('"fileQuery"')]);
    expect(answer).toMatchObject({ status: 'answered', route: 'ask', steps: 2, calls: 4, model: 'configured-model' });
    expect(turnOf(r)).toMatchObject({ modelCalls: 4, steps: 2 });
    expect(r.events.filter((event) => event.action === 'assistant.step')).toHaveLength(2);
  });

  it('reads the view again when the model asks for it, and counts it as a step', async () => {
    const r = await rig({ reply: SHARED, step: sequence(VIEW_TOOL, DONE), answer: GOOD });
    await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(r.elementReads).toHaveLength(1);
    expect(turnOf(r)).toMatchObject({ modelCalls: 4, steps: 2 });
  });

  it('asks once more for a request that is not valid and then ends the turn with the fixed sentence, nothing run', async () => {
    const r = await rig({ reply: SHARED, step: sequence(ok('read everything'), ok('{"tool":"dropEverything","values":{}}')) });
    const before = r.runs.length;
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', route: 'refuse', cause: 'unplaced', sentence: ASSISTANT_REFUSAL_SENTENCES.unplaced });
    expect(stepCalls(r)).toHaveLength(2);
    expect(r.runs.length - before).toBe(1);
  });

  it('ends the turn at once, with no repeat, when the calls limit leaves no room for the answer', async () => {
    const r = await rig({ reply: SHARED, step: sequence(ok('read everything')), maxCalls: 3, routerMaxCalls: 1 });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(stepCalls(r)).toHaveLength(1);
    expect(answer).toMatchObject({ status: 'answered', route: 'refuse', cause: 'unplaced' });
  });

  it('answers over what was read, with no call to choose a read it may not make, when the steps of the turn are spent', async () => {
    const r = await rig({ reply: SHARED, step: sequence(byId('A-2'), byId('A-3')), answer: GOOD, loopSteps: 2 });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', route: 'ask', steps: 2, calls: 3 });
    expect(stepCalls(r)).toHaveLength(1);
    expect(r.runs).toHaveLength(2);
    expect(turnOf(r)).toMatchObject({ outcome: 'answered', steps: 2, modelCalls: 3 });
  });

  it('answers over what was read when only the call kept for the answer is left, and chooses no further read', async () => {
    const r = await rig({ reply: SHARED, step: sequence(byId('A-2'), byId('A-3')), answer: GOOD, maxCalls: 4 });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', route: 'ask', steps: 3, calls: 4 });
    expect(r.runs).toHaveLength(3);
    expect(stepCalls(r)).toHaveLength(2);
  });

  it('keeps the call of the answer when the router and the step each needed a repeat, at the default limit of 5 calls', async () => {
    const r = await rig({ reply: sequence(ok('The first read is the customer. {"route":"ask"}'), SHARED), step: sequence(ok('Next I need more. {"tool":"byId"}'), byId('A-2'), DONE), answer: GOOD, routerMaxCalls: 5 });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', route: 'ask', steps: 2, calls: 5 });
    expect(stepCalls(r)).toHaveLength(2);
    expect(turnOf(r)).toMatchObject({ outcome: 'answered', modelCalls: 5, steps: 2 });
  });

  it('answers over what was read, and reads nothing more, when the reads already hold the rows a turn may read', async () => {
    const r = await rig({ reply: SHARED, step: sequence(byId('A-2'), byId('A-3')), answer: GOOD, loopRows: 3 });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', route: 'ask' });
    expect(r.runs.length).toBeLessThanOrEqual(2);
    expect(stepCalls(r).length).toBeLessThanOrEqual(1);
  });

  it('keeps Ask’s own answer when the rows of the first read already reach the limit', async () => {
    const r = await rig({ reply: SHARED, step: sequence(byId('A-2')), loopRows: 1 });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(rowsOf(answer)?.intent).toBe('shared');
    expect(r.runs).toHaveLength(1);
    expect(stepCalls(r)).toHaveLength(0);
  });

  it('stops at Ask’s heavy stop, with its continue token, when a step would read a heavy result', async () => {
    const r = await rig({ reply: SHARED, step: sequence(byId('A-2'), DONE), run: () => ({ status: 'ok', result: r2.next() }) });
    const r2 = { calls: 0, next: () => (r2.calls++ === 0 ? okResult() : heavyResult()) };
    const answer = await answerOf(r.route.handler(r.request()));
    expect(rowsOf(answer)?.continueToken).toBeDefined();
  });

  it('keeps the first answer when the step call fails', async () => {
    const r = await rig({ reply: SHARED, step: sequence({ kind: 'failed', code: 'unreachable' }) });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(rowsOf(answer)).toMatchObject({ intent: 'shared' });
  });

  it('starts no step for a turn that was cancelled after its first read', async () => {
    const controller = new AbortController();
    const r = await rig({ reply: SHARED, step: sequence(byId('A-2')), run: () => (controller.abort(), { status: 'ok', result: okResult() }) });
    await expect(r.route.handler(r.request(BODY, { signal: controller.signal }))).rejects.toThrow('cancelled');
    expect(stepCalls(r)).toHaveLength(0);
  });
});
