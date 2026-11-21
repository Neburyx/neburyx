import { ExtensionRefusal, type AskAnswer } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import type { FixtureReply } from '../../../ai-runtime/src/testing/fixture.js';
import { answerOf, offerOf, ok, okResult as okResultOf, rig, routeAsk } from '../testing/assistant-rig.js';

afterAll(removeAskFolders);

/**
 * A value the person writes for a role that needs a type is looked up through the gate before the intent runs. The role `id` of the intent `shared` needs the type `widget`; `K-1` stands for an element of another
 * mapped type (`gadget`) and `NOBODY` for an id that exists as nothing. The source's answer to the intent, if it ran, is scripted as the gate's own for an anchor that is not there: refused as not found, which Ask
 * answers as `nothing-found`.
 */
const NO_ANCHOR = { run: () => ({ status: 'refused' as const, refusal: { code: 'NOT_FOUND' as const } }) };
const TYPES = ['widget', 'gadget'] as const;

const askOf = (answer: Awaited<ReturnType<typeof answerOf>>): AskAnswer => {
  if (answer.status !== 'answered' || answer.route !== 'ask' || !('answer' in answer)) throw new Error(`not an ask answer: ${answer.status}`);
  return answer.answer;
};

describe('a written value on the ask route', () => {
  it.each([
    ['a value of another mapped type', 'K-1', ['gadget/K-1'], false, { kind: 'other-type', needed: 'widget', found: 'gadget' }, 'gadget K-1 is a gadget; this question needs a widget. Nothing was run.'],
    ['an id that exists as nothing', 'NOBODY', [], false, { kind: 'not-found', needed: 'widget' }, 'There is no widget with that id. Nothing was run.'],
    ['an id the read left something out for', 'NOBODY', [], true, { kind: 'hidden', needed: 'widget' }, 'That value does not give a widget this question can use. Nothing was run.'],
  ])('answers %s with the fixed refusal, runs nothing and reads the elements once through the gate', async (_name, value, source, omits, fit, sentence) => {
    const { route, request, runs, sourceReads } = await rig({ reply: routeAsk('shared', { id: value }), source, sourceOmits: omits, types: TYPES, ...NO_ANCHOR });
    const answer = askOf(await answerOf(route.handler(request())));
    expect(answer).toMatchObject({ refused: { cause: 'value-not-fit', intent: 'shared', sentence, valueNotFit: fit } });
    expect(runs).toHaveLength(0);
    expect(sourceReads).toHaveLength(1);
    expect(sourceReads[0]?.refs.entities.map((ref) => `${ref.entityType}/${ref.stableId}`)).toEqual([`widget/${value}`, `gadget/${value}`]);
  });

  it('runs the intent as it did for a value that is an element of the type its role needs', async () => {
    const { route, request, runs, sourceReads } = await rig({ reply: routeAsk('shared', { id: 'A-1' }), source: ['widget/A-1'], types: TYPES });
    expect(askOf(await answerOf(route.handler(request())))).toMatchObject({ answered: { intent: 'shared', entities: { id: 'A-1' } } });
    expect(runs).toHaveLength(1);
    expect(sourceReads).toHaveLength(1);
  });

  it('masks the lookup as the request says and cites the title the gate gave', async () => {
    const { route, request, sourceReads } = await rig({ reply: routeAsk('shared', { id: 'K-1' }), source: ['gadget/K-1'], types: TYPES });
    await route.handler(request({ sourceId: 'demo', investigationId: 'inv-1', message: 'Which accounts share a device with K-1?', viewElementKeys: [], mask: true }));
    expect(sourceReads[0]?.mask).toBe(true);
  });

  it('shows no refusal of this kind when the check is removed: the intent runs with the unchecked value and ends nothing found (the canary of every test above)', async () => {
    const { route, request, runs } = await rig({ reply: routeAsk('shared', { id: 'K-1' }), source: ['gadget/K-1'], types: TYPES, ...NO_ANCHOR });
    const answer = askOf(await answerOf(route.handler(request(undefined, { readSourceElements: undefined }))));
    expect(answer).toMatchObject({ refused: { cause: 'nothing-found', intent: 'shared' } });
    expect(runs).toHaveLength(1);
  });

  it('ends the turn as any read of it does when the read fails, and never answers that no element exists', async () => {
    const { route, request, runs } = await rig({ reply: routeAsk('shared', { id: 'K-1' }), types: TYPES });
    const answer = await answerOf(route.handler(request(undefined, { readSourceElements: () => Promise.reject(new ExtensionRefusal({ code: 'SOURCE_BUSY' } as never)) })));
    expect(answer).toMatchObject({ status: 'unavailable' });
    expect(runs).toHaveLength(0);
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
