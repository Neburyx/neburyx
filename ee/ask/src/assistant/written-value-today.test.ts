import type { AskAnswer } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import type { FixtureReply } from '../../../ai-runtime/src/testing/fixture.js';
import { answerOf, offerOf, ok, okResult as okResultOf, rig, routeAsk } from '../testing/assistant-rig.js';

afterAll(removeAskFolders);

/**
 * What a value the person writes does today, before it is checked against the type its role needs:
 * it is bound as the parameter as it stands and the intent runs, with no read of the element first.
 * The role `id` of the intent `shared` needs the type `widget`; `K-1` stands for an element of
 * another mapped type and `NOBODY` for an id that exists as nothing. The source's answer is scripted
 * as the gate's own: the anchor is not there as that type, so the run is refused as not found and
 * the answer is Ask's `nothing-found`, which reads as "no one shares it".
 * Each test here records the behaviour that the checking stories of the feature turn.
 */
const NO_ANCHOR = { run: () => ({ status: 'refused' as const, refusal: { code: 'NOT_FOUND' as const } }) };

const askOf = (answer: Awaited<ReturnType<typeof answerOf>>): AskAnswer => {
  if (answer.status !== 'answered' || answer.route !== 'ask' || !('answer' in answer)) throw new Error(`not an ask answer: ${answer.status}`);
  return answer.answer;
};

describe('a written value on the ask route, today', () => {
  it.each([
    ['a value of another mapped type', 'K-1'],
    ['an id that exists as nothing', 'NOBODY'],
  ])('runs the intent with %s as the parameter, reads no element to check it, and answers nothing found', async (_name, value) => {
    const { route, request, runs, elementReads } = await rig({ reply: routeAsk('shared', { id: value }), ...NO_ANCHOR });
    const answer = askOf(await answerOf(route.handler(request())));
    expect(runs).toHaveLength(1);
    expect(JSON.stringify(runs[0]?.asked)).toContain(value);
    expect(elementReads).toHaveLength(0);
    expect(answer).toMatchObject({ refused: { cause: 'nothing-found', intent: 'shared' } });
  });
});

describe('a written value on the saved-pattern anchor, today', () => {
  it('runs an asked pattern for an anchor of another type than the pattern starts at, reads no element to check it, and answers nothing found', async () => {
    const held = offerOf('22222222-2222-4222-8222-222222222222', 'A-PATTERN');
    const asked = { ...held, projection: { ...held.projection, startingEntity: 'asked' as const } };
    const { route, request, runs, elementReads } = await rig({ patterns: [asked], reply: routeAsk('saved-pattern', { pattern: 'pat_1', anchor: 'K-1' }), ...NO_ANCHOR });
    expect(askOf(await answerOf(route.handler(request())))).toMatchObject({ refused: { cause: 'nothing-found' } });
    expect(JSON.stringify(runs[0]?.asked)).toContain('K-1');
    expect(elementReads).toHaveLength(0);
  });
});

describe('a written value in a step of the tool loop, today', () => {
  const sequence = (...replies: FixtureReply[]) => {
    let next = 0;
    return () => replies[Math.min(next++, replies.length - 1)] ?? ok('{"done":true}');
  };
  const GOOD = ok(JSON.stringify({ sentences: [{ text: 'Account A-1 is listed.', cites: ['r1'] }] }));

  it('runs the intent the model names with the value the model wrote, reads no element to check its type, and the step ends nothing found', async () => {
    const r = await rig({ reply: routeAsk('shared', { id: 'A-1' }), maxCalls: 10, loopSteps: 4, step: sequence(ok(JSON.stringify({ tool: 'shared', values: { id: 'K-1' } })), ok('{"done":true}')), answer: GOOD, run: (_continuing, asked) => (JSON.stringify(asked).includes('K-1') ? { status: 'refused', refusal: { code: 'NOT_FOUND' } } : { status: 'ok', result: okResultOf() }) });
    await answerOf(r.route.handler(r.request()));
    expect(r.runs.map((run) => JSON.stringify(run.asked)).some((asked) => asked.includes('K-1'))).toBe(true);
    expect(JSON.stringify(r.elementReads.map((read) => read.refs))).not.toContain('K-1');
  });
});
