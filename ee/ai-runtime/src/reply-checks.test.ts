import { describe, expect, it } from 'vitest';
import { createCheckRunner } from './check-runner.js';
import { judgeSentences, judgeInput, parseJudged, type CheckedText, type JudgeInput, type Judged } from './reply-checks.js';

const TEXT: CheckedText = {
  text: 'n1: Ledger A (id a1)\nn2: Ledger B (id b2)',
  keys: new Map([['n1', 'entity'], ['n2', 'entity']]),
  lines: new Map([['n1', 'Ledger A (id a1)'], ['n2', 'Ledger B (id b2)']]),
  inexactCounts: [],
  unknownCountKeys: new Set(),
};

describe('the shared reply checks on a text built without the summary', () => {
  it('keeps a sentence that cites a key the text holds', () => {
    expect(judgeSentences([{ text: 'Ledger A is listed.', cites: ['n1'] }], TEXT).kept).toHaveLength(1);
  });

  it('removes a sentence that cites a key the text does not hold', () => {
    const judged = judgeSentences([{ text: 'Ledger A is listed.', cites: ['n9'] }], TEXT);
    expect(judged.kept).toEqual([]);
    expect(judged.removed).toBe(1);
  });

  it('removes a sentence with a number that is not on the cited lines', () => {
    expect(judgeSentences([{ text: 'Ledger A has 7311 rows.', cites: ['n1'] }], TEXT).kept).toEqual([]);
  });
});

describe('the check as a worker thread runs it', () => {
  const sentences = [{ text: 'Ledger A is listed.', cites: ['n1'] }, { text: 'Ledger A has 7311 rows.', cites: ['n1'] }];

  it('gives the same result in a worker as in place, with the real check module', async () => {
    let now = 0;
    const runner = createCheckRunner({ thresholdMs: 5, clock: () => now, workerUrl: new URL('./check-worker.ts', import.meta.url) });
    const check = { name: 'judge', inline: (input: JudgeInput): Judged => (now += 100, judgeInput(input)), module: { url: new URL('./reply-checks.ts', import.meta.url).href, exportName: 'judgeInput' }, parse: parseJudged };
    const inPlace = await runner.run(check, { sentences, text: TEXT }, { timeoutMs: 5000 });
    const inWorker = await runner.run(check, { sentences, text: TEXT }, { timeoutMs: 5000 });
    expect(inPlace).toEqual({ status: 'done', value: judgeSentences(sentences, TEXT) });
    expect(inWorker).toEqual(inPlace);
  });

  it('reads only the result of the check', () => {
    expect(parseJudged({ kept: [{ text: 'x', cites: ['n1'] }], removed: 0, keysStripped: 0, keysRemoved: 0, verdictFound: false })).toBeDefined();
    expect(parseJudged({ kept: 'x' })).toBeUndefined();
    expect(parseJudged({ kept: [{ text: 1 }], removed: 0, keysStripped: 0, keysRemoved: 0, verdictFound: false })).toBeUndefined();
  });
});
