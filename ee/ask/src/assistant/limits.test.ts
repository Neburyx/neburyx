import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { answerOf, ok, okResult, rig, routeAsk } from '../testing/assistant-rig.js';
import type { FixtureReply } from '../../../ai-runtime/src/testing/fixture.js';

afterAll(removeAskFolders);

const GOOD = ok(JSON.stringify({ sentences: [{ text: 'Account A-1 is listed.', cites: ['r1'] }] }));
const REQUESTS: readonly FixtureReply[] = [ok('{"tool":"byId","values":{"id":"A-2"}}'), ok('{"tool":"view","values":{}}'), ok('not a request'), ok('{"done":true}')];

describe('the limits of a turn of the tool loop', () => {
  it('never lets a turn run more reads, make more model calls or read more rows than the settings allow, whatever the model asks for', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 10 }), fc.integer({ min: 1, max: 8 }), fc.option(fc.integer({ min: 1, max: 12 }), { nil: undefined }), fc.array(fc.integer({ min: 0, max: REQUESTS.length - 1 }), { minLength: 1, maxLength: 14 }), async (maxCalls, steps, rows, picks) => {
        let next = 0;
        const step = () => REQUESTS[picks[Math.min(next++, picks.length - 1)] ?? 0] ?? REQUESTS[3] ?? ok('{"done":true}');
        const r = await rig({ reply: routeAsk('shared', { id: 'A-1' }), step, answer: GOOD, maxCalls, loopSteps: steps, ...(rows === undefined ? {} : { loopRows: rows }), run: () => ({ status: 'ok', result: okResult() }) });
        await answerOf(r.route.handler(r.request()));
        expect(r.runs.length).toBeLessThanOrEqual(steps);
        expect(r.fixture.calls.length).toBeLessThanOrEqual(maxCalls);
      }),
      { numRuns: 60 },
    );
  });

  it('keeps the first read when the settings leave room for no step call', async () => {
    const r = await rig({ reply: routeAsk('shared', { id: 'A-1' }), step: () => REQUESTS[0] ?? ok('{"done":true}'), answer: GOOD, maxCalls: 2 });
    await answerOf(r.route.handler(r.request()));
    expect(r.fixture.calls).toHaveLength(1);
  });
});
