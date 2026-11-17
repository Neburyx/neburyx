import { JUDGE_MODULE, createCheckRunner, judgeSentences, parseJudged, type CheckedText, type JudgeInput } from '@neburyx/ee-ai-runtime';
import { describe, expect, it } from 'vitest';

const TEXT: CheckedText = { text: 'n1: Ledger A', keys: new Map([['n1', true]]), lines: new Map([['n1', 'Ledger A']]), inexactCounts: [], unknownCountKeys: new Set() };
const SENTENCES = [{ text: 'Ledger A is listed.', cites: ['n1'] }, { text: 'Ledger B is listed.', cites: ['n9'] }];

describe('the check runner of the built package, with its own worker script and the real check module', () => {
  it('gives in a worker thread the result the check gives in place', async () => {
    let now = 0;
    const runner = createCheckRunner({ thresholdMs: 1, clock: () => now });
    const check = { name: 'built-judge', inline: (input: JudgeInput) => ((now += 100), judgeSentences(input.sentences, input.text)), module: JUDGE_MODULE, parse: parseJudged };
    const inPlace = await runner.run(check, { sentences: SENTENCES, text: TEXT }, { timeoutMs: 10_000 });
    const inWorker = await runner.run(check, { sentences: SENTENCES, text: TEXT }, { timeoutMs: 10_000 });
    expect(inPlace).toMatchObject({ status: 'done', value: { removed: 1 } });
    expect(inWorker).toEqual(inPlace);
  });
});
