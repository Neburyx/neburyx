import { ASSISTANT_CONFIRMATION_INVALID_SENTENCE, ASSISTANT_LIMIT_SENTENCES, ExtensionRefusal, askRunResultSchema, type AssistantTurnAnswer } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import type { FixtureReply } from '../../../ai-runtime/src/testing/fixture.js';
import { removeAskFolders } from '../testing/ask-folder.js';
import { BODY, VIEW_BODY, answerOf, heavyResult, nodeOf, offerOf, ok, okResult, rig, routeAsk, zeroResult, type Rig, type RigOptions } from '../testing/assistant-rig.js';
import { createMemoryAssistantPendingStore } from './pending-store.js';
import { CONFIRMATION_ACTION } from './confirmation.js';
import { TURN_CLOSED_ACTION } from './turn-audit.js';

afterAll(removeAskFolders);

const SHARED = routeAsk('shared', { id: 'A-1' });
const DONE = ok('{"done":true}');
const byId = (id: string) => ok(JSON.stringify({ tool: 'byId', values: { id } }));
const GOOD = ok(JSON.stringify({ sentences: [{ text: 'Account A-1 and account A-2 are listed.', cites: ['r1', 'r2'] }] }));
const sequence = (...replies: FixtureReply[]) => {
  let next = 0;
  return () => replies[Math.min(next++, replies.length - 1)] ?? DONE;
};

/** The first read and every read made again as an `ok` result; the step `byId` of `A-9` is heavy until it is read as a continue. */
const runOf = (heavyFor = 'A-9') => (continuing: boolean, asked: unknown) => {
  const text = JSON.stringify(asked);
  return text.includes(heavyFor) && !continuing ? { status: 'ok' as const, result: heavyResult() } : { status: 'ok' as const, result: okResult() };
};

async function waiting(over: Partial<RigOptions> = {}) {
  const pending = createMemoryAssistantPendingStore();
  const opts: RigOptions = { reply: SHARED, step: sequence(byId('A-2'), byId('A-9'), DONE), answer: GOOD, pending, run: runOf(), ...over };
  const r = await rig(opts);
  const first = await answerOf(r.route.handler(r.request()));
  if (first.status !== 'confirmation') throw new Error(`not waiting: ${JSON.stringify(first).slice(0, 200)}`);
  return { r, pending, first, opts };
}

const decide = (r: Rig, first: Extract<AssistantTurnAnswer, { status: 'confirmation' }>, decision: 'confirm' | 'skip' | 'cancel', over: Record<string, unknown> = {}) =>
  answerOf(r.route.handler(r.request({ ...BODY, ...over, confirmation: { pendingId: first.pendingId, plan: first.plan, decision } })));

const agentCalls = (r: Rig): number => r.events.filter((event) => event.action === 'assistant.agent').length;
const events = (r: Rig) => r.events.filter((event) => event.action === CONFIRMATION_ACTION).map((event) => (event.detail as { turn: { cause: string; intent?: string } }).turn);
const closings = (r: Rig) => r.events.filter((event) => event.action === TURN_CLOSED_ACTION).map((event) => (event.detail as { turn: Record<string, unknown> }).turn);

describe('a heavy step of the loop waits for the analyst', () => {
  it('reads nothing of the step, makes no further model call, and answers with what it would read, the reads made so far and a signed plan with no token in it', async () => {
    const { r, first, pending } = await waiting();
    expect(first.step).toMatchObject({ tool: 'byId', kind: 'intent', subject: 'A-9', count: { quality: 'lowerBound' }, page: expect.any(Number) });
    expect(first.reads).toMatchObject([{ tool: 'shared', read: true }, { tool: 'byId', subject: 'A-2', read: true }]);
    // the first read, the second read and the read of the heavy step, which stopped at its count and read no page
    expect(r.runs).toHaveLength(3);
    expect(r.runs.filter((run) => (run.options as { continue?: boolean } | undefined)?.continue === true)).toHaveLength(0);
    expect(agentCalls(r)).toBe(3);
    expect(JSON.stringify(first)).not.toMatch(/continueToken|"result"/);
    expect([...pending.rows.values()]).toMatchObject([{ status: 'waiting', investigationId: BODY.investigationId, sourceId: BODY.sourceId }]);
    expect(closings(r)).toMatchObject([{ outcome: 'confirmation', route: 'ask' }]);
    expect(events(r)).toEqual([expect.objectContaining({ cause: 'shown', intent: 'byId' })]);
  });

  it('waits for the analyst for a first read that is heavy, with the step it would read and nothing read', async () => {
    const pending = createMemoryAssistantPendingStore();
    const r = await rig({ reply: routeAsk('shared', { id: 'A-9' }), step: sequence(DONE), answer: GOOD, pending, run: runOf() });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'confirmation', step: { tool: 'shared' } });
    expect(pending.rows.size).toBe(1);
  });

  it('stops the turn as unavailable, with nothing read and nothing waiting, when the store cannot be reached', async () => {
    const pending = createMemoryAssistantPendingStore();
    pending.failing = true;
    const r = await rig({ reply: SHARED, step: sequence(byId('A-2'), byId('A-9'), DONE), answer: GOOD, pending, run: runOf() });
    expect(await answerOf(r.route.handler(r.request()))).toMatchObject({ status: 'unavailable', kind: 'service', readStarted: true });
    expect(r.runs).toHaveLength(3);
  });

  it('replaces the confirmation of a person with a new one, and drops it when the person sends another message', async () => {
    const { r, first, pending } = await waiting();
    await answerOf(r.route.handler(r.request({ ...BODY, message: 'something else' })));
    expect([...pending.rows.values()].map((row) => row.status)).toEqual(['dropped']);
    expect(events(r).map((event) => event.cause)).toEqual(['shown', 'replaced']);
    expect(await decide(r, first, 'confirm')).toMatchObject({ status: 'confirmation-invalid', sentence: ASSISTANT_CONFIRMATION_INVALID_SENTENCE });
  });

  it('audits a replaced confirmation with the investigation it was waiting in, not the one that replaced it', async () => {
    const { r } = await waiting({ step: sequence(byId('A-2'), byId('A-9'), byId('A-2'), byId('A-9')) });
    const second = await answerOf(r.route.handler(r.request({ ...BODY, investigationId: 'inv-2' })));
    expect(second.status).toBe('confirmation');
    const replaced = r.events.filter((event) => event.action === CONFIRMATION_ACTION && (event.detail as { turn: { cause: string } }).turn.cause === 'replaced');
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ investigationId: BODY.investigationId, sourceId: BODY.sourceId });
    expect(JSON.stringify(replaced[0]?.detail)).not.toContain('intent');
  });

  it('lets a new message run when the store cannot be reached', async () => {
    const { r, pending } = await waiting();
    pending.failing = true;
    const answer = await answerOf(r.route.handler(r.request({ ...BODY, message: 'something else' })));
    expect(answer.status).not.toBe('unavailable');
  });
});

describe('Confirm runs the step', () => {
  it('reads the earlier steps again, reads the step as one bounded page and goes on to the answer, as a turn of its own naming the one it resumes', async () => {
    const { r, first } = await waiting({ step: sequence(byId('A-2'), byId('A-9'), DONE) });
    const readsBefore = r.runs.length;
    const answer = await decide(r, first, 'confirm');
    expect(answer).toMatchObject({ status: 'answered', route: 'ask', steps: 3 });
    expect(r.runs.slice(readsBefore).map((run) => (run.options as { continue?: boolean } | undefined)?.continue === true)).toEqual([false, false, true]);
    const [, resumed] = closings(r);
    expect(resumed).toMatchObject({ outcome: 'answered', route: 'ask', resumes: expect.any(String) });
    expect(events(r).map((event) => event.cause)).toEqual(['shown', 'confirm']);
    const readEvents = r.events.filter((event) => (event.detail as { askRun?: { replay?: boolean } } | undefined)?.askRun?.replay === true);
    expect(readEvents).toHaveLength(2);
  });

  it('counts the confirmed step with its rows and, with the answer, names the reads in order', async () => {
    const { r, first } = await waiting();
    const answer = await decide(r, first, 'confirm');
    if (answer.status !== 'answered' || !('reads' in answer) || !('steps' in answer)) throw new Error('not a steps answer');
    expect(answer.reads.map((entry) => entry.tool)).toEqual(['shared', 'byId', 'byId']);
    expect(answer.steps).toBe(3);
  });

  it('runs a plan once when it is sent twice at the same time', async () => {
    const { r, first } = await waiting();
    const [one, two] = await Promise.all([decide(r, first, 'confirm'), decide(r, first, 'confirm')]);
    expect([one.status, two.status].sort()).toEqual(['answered', 'confirmation-invalid']);
    expect(r.runs.filter((run) => (run.options as { continue?: boolean } | undefined)?.continue === true)).toHaveLength(1);
  });

  it('holds in its plan tools, accepted values and counters, and none of what the reads returned', async () => {
    const { first } = await waiting();
    const [, payload = ''] = first.plan.split('.');
    const text = Buffer.from(payload, 'base64url').toString('utf8');
    expect(text).not.toMatch(/Account|display|properties|continueToken|SENTINEL/);
    expect(JSON.parse(text)).toMatchObject({ steps: [{ tool: 'shared' }, { tool: 'byId', values: { id: 'A-2' } }], wait: { tool: 'byId', values: { id: 'A-9' } }, counters: { steps: 2, calls: 4 } });
  });

  it('never runs a plan twice: the second use is refused and audited as invalid', async () => {
    const { r, first } = await waiting();
    await decide(r, first, 'confirm');
    const runs = r.runs.length;
    expect(await decide(r, first, 'confirm')).toMatchObject({ status: 'confirmation-invalid' });
    expect(await decide(r, first, 'skip')).toMatchObject({ status: 'confirmation-invalid' });
    expect(r.runs.length).toBe(runs);
    expect(events(r).filter((event) => event.cause === 'invalid-used')).toHaveLength(2);
  });

  it.each([
    ['steps', { loopSteps: 2 }, 'answered', 'steps'],
    ['rows', { loopRows: 1 }, 'answered', 'rows'],
    ['time', {}, 'limit', 'time'],
    ['calls', { maxCalls: 3 }, 'limit', 'calls'],
    ['input', { maxInputTokens: 20 }, 'limit', 'input'],
  ] as const)('reads nothing of the heavy step when the %s limit is spent at the moment of the decision, and a decision never lifts it', async (name, limits, status, limit) => {
    const pending = createMemoryAssistantPendingStore();
    const options: RigOptions = { reply: SHARED, step: sequence(byId('A-2'), byId('A-9'), DONE), answer: GOOD, pending, run: runOf(), loopSteps: 4 };
    const r = await rig(options);
    const first = await answerOf(r.route.handler(r.request()));
    if (first.status !== 'confirmation') throw new Error('not waiting');
    const readsBefore = r.runs.length;
    // the settings are read when a limit is tested, so a limit seeded now is the limit the decision meets
    Object.assign(options, limits);
    const answer = await (async () => {
      if (name === 'time') r.expire();
      return decide(r, first, 'confirm');
    })();
    expect(r.runs.slice(readsBefore).some((run) => (run.options as { continue?: boolean } | undefined)?.continue === true)).toBe(false);
    expect(answer).toMatchObject(status === 'limit' ? { status: 'limit', limit } : { status: 'answered', stoppedAt: limit });
  });
});

describe('Skip, Cancel and a confirmation that is no longer valid', () => {
  it('skips the step: it is read again nowhere, the earlier steps are, and the model is told only that the analyst skipped it', async () => {
    const { r, first } = await waiting();
    const readsBefore = r.runs.length;
    const answer = await decide(r, first, 'skip');
    expect(answer).toMatchObject({ status: 'answered', route: 'ask' });
    expect(r.runs.slice(readsBefore).every((run) => (run.options as { continue?: boolean } | undefined)?.continue !== true)).toBe(true);
    expect(events(r).map((event) => event.cause)).toEqual(['shown', 'skip']);
  });

  it('cancels: nothing is read, not even the earlier steps, and the turn ends as cancelled', async () => {
    const { r, first, pending } = await waiting();
    const readsBefore = r.runs.length;
    expect(await decide(r, first, 'cancel')).toEqual({ status: 'cancelled' });
    expect(r.runs.length).toBe(readsBefore);
    expect(closings(r).at(-1)).toMatchObject({ outcome: 'cancelled' });
    expect([...pending.rows.values()].map((row) => row.status)).toEqual(['used']);
    expect(events(r).map((event) => event.cause)).toEqual(['shown', 'cancel']);
  });

  it.each([
    ['the message was changed', { message: 'another message' }, 'message'],
    ['the view was changed', { viewElementKeys: ['n9'] }, 'view'],
  ])('is refused when %s, and reads nothing', async (_name, over, cause) => {
    const { r, first } = await waiting();
    const readsBefore = r.runs.length;
    expect(await decide(r, first, 'confirm', over)).toMatchObject({ status: 'confirmation-invalid' });
    expect(r.runs.length).toBe(readsBefore);
    expect(events(r).at(-1)).toMatchObject({ cause: `invalid-${cause}` });
  });

  it('is refused for a plan that is altered, for a pending id that was never given, and for another person’s', async () => {
    const { r, first } = await waiting();
    const readsBefore = r.runs.length;
    const [expiry = '', payload = '', signature = ''] = first.plan.split('.');
    const altered = `${expiry}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), wait: { tool: 'byId', values: { id: 'A-1' } } })).toString('base64url')}.${signature}`;
    expect(await answerOf(r.route.handler(r.request({ ...BODY, confirmation: { pendingId: first.pendingId, plan: altered, decision: 'confirm' } })))).toMatchObject({ status: 'confirmation-invalid' });
    expect(await answerOf(r.route.handler(r.request({ ...BODY, confirmation: { pendingId: '0192f000-0000-7000-8000-000000000001', plan: first.plan, decision: 'confirm' } })))).toMatchObject({ status: 'confirmation-invalid' });
    expect(await answerOf(r.route.handler(r.request({ ...BODY, confirmation: { pendingId: first.pendingId, plan: first.plan, decision: 'confirm' } }, { principalId: 'someone-else' })))).toMatchObject({ status: 'confirmation-invalid' });
    expect(r.runs.length).toBe(readsBefore);
  });

  it('is refused when the confirmation has expired, and the expiry is found and audited at that moment', async () => {
    const { r, first, pending } = await waiting();
    r.clock.now += 15.5 * 60 * 1000;
    expect(await decide(r, first, 'confirm')).toMatchObject({ status: 'confirmation-invalid' });
    expect(events(r).map((event) => event.cause)).toContain('expired');
    expect(pending.rows.size).toBe(0);
  });

  it('is refused with the fixed sentence when the store cannot be reached to claim it, and nothing is read', async () => {
    const { r, first, pending } = await waiting();
    pending.failing = true;
    const readsBefore = r.runs.length;
    expect(await decide(r, first, 'confirm')).toMatchObject({ status: 'unavailable', readStarted: false });
    expect(r.runs.length).toBe(readsBefore);
  });
});

describe('the limits of a turn that goes on after a decision', () => {
  it('has the fixed sentences of the limits, none with a digit', () => {
    for (const sentence of Object.values(ASSISTANT_LIMIT_SENTENCES)) expect(sentence).not.toMatch(/\d/);
  });
});

type Run = NonNullable<RigOptions['run']>;
const readsOf = (answer: AssistantTurnAnswer) => (answer.status === 'answered' && 'reads' in answer ? (answer.reads ?? []) : []);
const GOOD_PLAIN = ok(JSON.stringify({ sentences: [{ text: 'Account Z-0 is listed.', cites: ['r1'] }] }));
const asks = (text: unknown, id: string): boolean => JSON.stringify(text).includes(`"${id}"`);
const continuing = (r: Rig) => r.runs.map((run) => (run.options as { continue?: boolean } | undefined)?.continue === true);
const bigResult = () =>
  askRunResultSchema.parse({ templateId: 'file-query', result: { status: 'ok', intent: 'byId', count: { quality: 'exact', value: 12, scope: 'rows' }, nodes: Array.from({ length: 12 }, (_, index) => nodeOf(`Z-${index}`)), edges: [], notices: [], warnings: [] } });

/** A turn that waits at a heavy step, whose reads then behave as `onReplay` says when they are read again (`seen` counts the reads of an id). */
async function replayed(onReplay: (seen: number, id: string, continuing: boolean) => ReturnType<Run>, over: Partial<RigOptions> = {}) {
  const seen = new Map<string, number>();
  const run: Run = (isContinue, asked) => {
    const id = ['A-1', 'A-2', 'A-9'].find((candidate) => asks(asked, candidate)) ?? 'A-1';
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    if (id === 'A-9') return isContinue ? { status: 'ok', result: okResult() } : { status: 'ok', result: heavyResult() };
    return count === 1 ? { status: 'ok', result: okResult() } : onReplay(count, id, isContinue);
  };
  return waiting({ run, ...over });
}

describe('a decision reads the earlier steps again, and meets what changed', () => {
  it('goes on over what the reads gave now, never over what they gave the first time', async () => {
    const { r, first } = await replayed(() => ({ status: 'ok', result: zeroResult() }));
    const answer = await decide(r, first, 'confirm');
    const reads = readsOf(answer);
    expect(reads[0]).toMatchObject({ tool: 'shared', rows: 0, quality: 'exact' });
  });

  it('does not read the heavy step when the replayed reads reach the rows of the turn, and answers over what was read with the limit named', async () => {
    const { r, first, opts } = await replayed(() => ({ status: 'ok', result: bigResult() }), { loopRows: 20, answer: GOOD_PLAIN });
    const before = r.runs.length;
    // the settings are read when a limit is tested: the replayed reads now hold more rows than the turn may read
    Object.assign(opts, { loopRows: 5 });
    const answer = await decide(r, first, 'confirm');
    expect(answer).toMatchObject({ status: 'answered', stoppedAt: 'rows' });
    expect(continuing(r).slice(before).some(Boolean)).toBe(false);
  });

  it('lists a replayed read that is now heavy as not read, reads no page of it, and goes on', async () => {
    const { r, first } = await replayed((_count, id) => ({ status: 'ok', result: id === 'A-2' ? heavyResult() : okResult() }));
    const answer = await decide(r, first, 'confirm');
    const reads = readsOf(answer);
    expect(reads.find((entry) => entry.tool === 'byId' && !entry.read)).toBeDefined();
    expect(reads.filter((entry) => entry.tool === 'byId' && entry.read)).toHaveLength(1);
  });

  it('lists a replayed read the gate refuses as not read, and goes on', async () => {
    const { r, first } = await replayed((_count, id) => {
      if (id === 'A-2') throw new ExtensionRefusal({ code: 'ASK_INTENT_INVALID' });
      return { status: 'ok', result: okResult() };
    });
    const answer = await decide(r, first, 'confirm');
    expect(readsOf(answer).find((entry) => entry.tool === 'byId' && !entry.read)).toBeDefined();
  });

  it('ends the decision as unavailable with a read started when the source fails during the replay, and the confirmation is used', async () => {
    const { r, first, pending } = await replayed((_count, id) => {
      if (id === 'A-2') throw new ExtensionRefusal({ code: 'SOURCE_UNAVAILABLE', reason: 'unreachable' });
      return { status: 'ok', result: okResult() };
    });
    expect(await decide(r, first, 'confirm')).toMatchObject({ status: 'unavailable', kind: 'source-unavailable', readStarted: true });
    expect([...pending.rows.values()].map((row) => row.status)).toEqual(['used']);
    expect(await decide(r, first, 'confirm')).toMatchObject({ status: 'confirmation-invalid' });
  });

  it('reads a step the analyst confirmed as its one page when a later decision reads it again, and a second confirmation waits too', async () => {
    const pending = createMemoryAssistantPendingStore();
    const run: Run = (isContinue, asked) => (asks(asked, 'A-9') || asks(asked, 'A-8')) && !isContinue ? { status: 'ok', result: heavyResult() } : { status: 'ok', result: okResult() };
    const r = await rig({ reply: SHARED, step: sequence(byId('A-9'), byId('A-8'), DONE), answer: GOOD, pending, run });
    const first = await answerOf(r.route.handler(r.request()));
    if (first.status !== 'confirmation') throw new Error('not waiting');
    const second = await decide(r, first, 'confirm');
    if (second.status !== 'confirmation') throw new Error(`no second confirmation: ${JSON.stringify(second).slice(0, 160)}`);
    expect(second.reads.map((entry) => entry.tool)).toEqual(['shared', 'byId']);
    const before = r.runs.length;
    const done = await decide(r, second, 'confirm');
    expect(done).toMatchObject({ status: 'answered', route: 'ask' });
    // the first, the step confirmed before (as its one page), then the step now confirmed
    expect(continuing(r).slice(before)).toEqual([false, true, true]);
  });

  it('reads the view again from the keys that were sent when the turn began from the view, and goes on from it', async () => {
    const pending = createMemoryAssistantPendingStore();
    const r = await rig({ reply: ok('{"route":"view"}'), step: sequence(ok('{"tool":"view","values":{}}'), byId('A-9'), DONE), answer: ok(JSON.stringify({ sentences: [{ text: 'Account A-1 and account A-2 are listed.', cites: ['n1', 'n2'] }] })), pending, run: runOf() });
    const first = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    if (first.status !== 'confirmation') throw new Error(`not waiting: ${JSON.stringify(first).slice(0, 160)}`);
    expect(first.reads).toMatchObject([{ tool: 'view', kind: 'view' }]);
    const readsBefore = r.elementReads.length;
    const answer = await answerOf(r.route.handler(r.request({ ...VIEW_BODY, confirmation: { pendingId: first.pendingId, plan: first.plan, decision: 'confirm' } })));
    expect(answer).toMatchObject({ status: 'answered', route: 'view' });
    expect(r.elementReads.length - readsBefore).toBe(1);
  });

  it('does not count the time of the wait: a decision long after still has the time the turn had left', async () => {
    const { r, first } = await waiting({ totalTimeoutMs: 60_000 });
    r.clock.now += 10 * 60 * 1000;
    expect(await decide(r, first, 'confirm')).toMatchObject({ status: 'answered' });
  });
});

describe('a step that is no longer available is refused as invalid, and is never read as a skip', () => {
  it('refuses a plan whose tool the registry no longer offers, with nothing read and the row left unused', async () => {
    const { r, first, pending } = await waiting();
    const [expiry = '', payload = '', signature = ''] = first.plan.split('.');
    expect(expiry.length + payload.length + signature.length).toBeGreaterThan(0);
    // the folder loses the intent: a rig with no folder offers no tool at all
    const bare = await rig({ reply: SHARED, step: sequence(byId('A-2'), byId('A-9'), DONE), answer: GOOD, pending, run: runOf(), noFolder: true });
    const readsBefore = bare.runs.length;
    expect(await decide(bare, first, 'confirm')).toMatchObject({ status: 'confirmation-invalid' });
    expect(bare.runs.length).toBe(readsBefore);
    expect([...pending.rows.values()].map((row) => row.status)).toEqual(['waiting']);
    expect(r.runs.length).toBeGreaterThan(0);
  });
});

describe('a turn whose first read was a saved pattern', () => {
  it('reads the pattern again under its own name when a decision is made, and lists it as a read of a pattern', async () => {
    const pending = createMemoryAssistantPendingStore();
    const pattern = offerOf('22222222-2222-4222-8222-222222222222', 'Mine');
    const r = await rig({ patterns: [pattern], reply: routeAsk('saved-pattern', { pattern: 'pat_1' }), step: sequence(byId('A-9'), DONE), answer: GOOD, pending, run: runOf() });
    const first = await answerOf(r.route.handler(r.request()));
    if (first.status !== 'confirmation') throw new Error(`not waiting: ${JSON.stringify(first).slice(0, 200)}`);
    expect(first.reads[0]).toMatchObject({ kind: 'pattern', tool: 'Mine', read: true });
    const before = r.runs.length;
    const answer = await decide(r, first, 'confirm');
    expect(readsOf(answer)[0]).toMatchObject({ kind: 'pattern', tool: 'Mine', read: true });
    expect(r.runs.length - before).toBe(2);
  });
});

describe('a decision that cannot be made does not use the confirmation up', () => {
  it('answers that nothing was read, and leaves the confirmation waiting, when the turn has no loop', async () => {
    const { first, pending } = await waiting();
    const noLoop = await rig({ reply: SHARED, answer: GOOD, pending, run: runOf() });
    const answer = await decide(noLoop, first, 'confirm');
    expect(answer).toMatchObject({ status: 'unavailable', readStarted: false });
    expect([...pending.rows.values()].map((row) => row.status)).toEqual(['waiting']);
  });
});

describe('the label of a waiting intent', () => {
  const intents = { byId: { label: 'Account by id', parameters: ['id'], query: 'MATCH (n) WHERE n.id = $id RETURN n LIMIT 5' }, shared: { parameters: ['id'], template: 'shared-attribute', settings: { ref: { entityType: 'widget', stableId: '$id' }, attributeType: 'shape', via: 'USES_SHAPE' } } };

  it('is on the step the analyst is asked about and on its read, and the plan still names the id', async () => {
    const { first } = await waiting({ intents });
    expect(first.step).toMatchObject({ tool: 'byId', label: 'Account by id' });
    expect(first.reads[1]).toMatchObject({ tool: 'byId', label: 'Account by id' });
    expect(first.reads[0]).not.toHaveProperty('label');
    expect(first.plan).not.toContain('Account by id');
  });
});

describe('the steps a streamed decision reports', () => {
  it('says a read for each earlier step it reads again and for the step it runs, then answering, with no routing', async () => {
    const { r, first } = await waiting();
    const events: { name: string; members: Record<string, unknown> }[] = [];
    const answer = await answerOf(r.route.handler(r.request({ ...BODY, confirmation: { pendingId: first.pendingId, plan: first.plan, decision: 'confirm' } }, { emit: (name: string, members: unknown) => events.push({ name, members: members as Record<string, unknown> }) })));
    expect(answer).toMatchObject({ status: 'answered' });
    const phases = events.map((event) => event.members['phase']);
    expect(phases).not.toContain('routing');
    expect(phases.at(-1)).toBe('answering');
    expect(events.filter((event) => event.members['phase'] === 'reading').map((event) => event.members['tool'])).toEqual(['shared', 'byId', 'byId']);
  });

  it('says a read and an answering for a skip, never routing', async () => {
    const { r, first } = await waiting();
    const events: Record<string, unknown>[] = [];
    await answerOf(r.route.handler(r.request({ ...BODY, confirmation: { pendingId: first.pendingId, plan: first.plan, decision: 'skip' } }, { emit: (_name: string, members: unknown) => events.push(members as Record<string, unknown>) })));
    expect(events.map((event) => event['phase'])).not.toContain('routing');
    expect(events.at(-1)?.['phase']).toBe('answering');
  });
});

describe('a plan that waits for a decision and the selection on the canvas', () => {
  it('is valid for a decision sent after the selection changed, because the plan is bound to the view and holds no selection', async () => {
    const pending = createMemoryAssistantPendingStore();
    const r = await rig({ reply: SHARED, step: sequence(byId('A-2'), byId('A-9'), DONE), answer: GOOD, pending, run: runOf() });
    const first = await answerOf(r.route.handler(r.request({ ...BODY, selectionKeys: [BODY.viewElementKeys[0] ?? ''] })));
    if (first.status !== 'confirmation') throw new Error('not waiting');
    const decided = await decide(r, first, 'skip');
    expect(decided).not.toMatchObject({ status: 'confirmation-invalid' });
  });
});
