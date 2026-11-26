import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import type { CheckedText, Judged } from './reply-checks.js';

/**
 * A check that never comes back cannot be stopped from inside its own thread, so every sentence here is judged in a worker that this test ends when one sentence takes longer than its bound. The worker loads the check's
 * source, whose only imports are types.
 */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.checks).then(({ judgeSentences }) => {
  parentPort.on('message', ({ sentence, text }) => {
    const judged = judgeSentences([sentence], text);
    parentPort.postMessage({ kept: judged.kept.length, reason: judged.rejected[0] && judged.rejected[0].reason });
  });
  parentPort.postMessage('ready');
});
`;

async function judgeEach(text: CheckedText, sentences: readonly string[], cites: readonly string[], boundMs: number): Promise<{ readonly kept: number; readonly reason?: Judged['rejected'][number]['reason'] }[]> {
  const worker = new Worker(WORKER, { eval: true, workerData: { checks: new URL('./reply-checks.ts', import.meta.url).href } });
  const next = (what: string, limit: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer within ${limit} ms for ${what}`)), limit);
      const done = (message: unknown): void => {
        clearTimeout(timer);
        worker.off('error', reject);
        resolve(message);
      };
      worker.once('message', done);
      worker.once('error', reject);
    });
  try {
    await next('the worker to start', 20_000);
    const out: { kept: number; reason?: Judged['rejected'][number]['reason'] }[] = [];
    for (const sentence of sentences) {
      const answer = next(JSON.stringify(sentence.slice(0, 200)), boundMs);
      worker.postMessage({ sentence: { text: sentence, cites: [...cites] }, text });
      out.push((await answer) as { kept: number; reason?: Judged['rejected'][number]['reason'] });
    }
    return out;
  } finally {
    await worker.terminate();
  }
}

describe.each([
  { name: 'transfers', item: 'transaction', holder: 'account', link: 'SENT', status: 'paymentFormat', statusWords: 'payment format' },
  { name: 'filings', item: 'claim', holder: 'provider', link: 'FILED', status: 'lossType', statusWords: 'loss type' },
])('the sentence check comes back for any sentence, in the words of the $name mapping', ({ item, holder, link, status, statusWords }) => {
  const entities = [['n1', item, 'Item A'], ['n2', item, 'Item B'], ['h', holder, 'Gamma']] as const;
  const links = [['e1', 'n1'], ['e2', 'n2']] as const;
  const lines = new Map<string, string>([...entities.map(([key, , title]) => [key, `${key}: ${title}`] as const), ...links.map(([key]) => [key, `${key}: ${link}`] as const), ['s1', 's1: read of lookup: 2 matches shown · exact'], ['c1', 'c1: view coverage: 3 entities shown']]);
  const end = (key: string): readonly [string, string] => {
    const found = entities.find(([own]) => own === key);
    return [found?.[1] ?? '', found?.[2] ?? ''];
  };
  const held: CheckedText = {
    text: [...lines.values()].join('\n'),
    keys: new Map([...lines.keys()].map((key) => [key, true])),
    lines,
    inexactCounts: [],
    unknownCountKeys: new Set(),
    elementTypes: new Map<string, string>([...entities.map(([key, type]) => [key, `entity ${type}`] as const), ...links.map(([key]) => [key, `relationship ${link}`] as const)]),
    elementNames: new Map(entities.map(([key, , title]) => [key, [title]])),
    elementEnds: new Map<string, readonly (readonly [string, string])[]>([...entities.map(([key]) => [key, [end(key)]] as const), ...links.map(([key, to]) => [key, [end('h'), end(to)]] as const)]),
    readKeys: new Set(['s1', 'c1']),
    readElements: new Map([['s1', ['e1', 'e2']]]),
    rankedValues: new Map(['n1', 'n2'].map((key, index) => [key, [{ key: status, dataClass: 'string' }, { key: 'amountDue', dataClass: 'number', value: String(10 * (index + 1)) }]])),
    elementValues: new Map(['n1', 'n2'].map((key, index) => [key, [{ key: status, text: index === 0 ? 'north' : 'south', masked: false }, { key: 'amountDue', text: String(10 * (index + 1)), masked: false }]])),
  };
  const cites = ['n1', 'n2', 'h', 'e1', 'e2', 's1', 'c1'];

  it('judges the sentences that opened with a turning word and once never came back', async () => {
    const opening = ['But', 'Although', 'And yet'].flatMap((word) => [`${word} they share the ${statusWords} north.`, `${word} both have the same ${statusWords}.`, `${word} the two are the same.`, `${word} they share a ${holder}.`, `Item A is listed. ${word} the two share the ${statusWords} north.`]);
    const judged = await judgeEach(held, [...opening, `Item A and Item B differ in amountDue but share the ${statusWords} north.`, 'But same', ', but same', 'but but but same'], cites, 2000);
    expect(judged).toHaveLength(opening.length + 4);
  }, 60_000);

  const WORDS = ['But', 'but', 'Although', 'and yet', 'And yet', ',', '.', ';', ':', '!', '?', 'same', 'share', 'shared', 'differ', 'different', 'vary', 'alike', 'identical', 'in common', 'common to', 'top', 'at the top', 'on top', 'by far', 'much more', 'than', 'all', 'not all', 'cannot', 'be named', 'no', 'none', 'not', 'whether', 'if', 'the', 'a', 'these', 'two', 'Item A', 'Item B', 'Gamma', item, `${item}s`, holder, statusWords, 'amountDue', '10', '1,000', '(', ')', '"', '“', '”', "'s", 'in', 'of', 'is', 'are', 'for', 'and', 'or', 'sender', 'sending', 'relationships', 'links', 'each', 'only', 'in view', 'among those read', 'largest', 'shown'];
  // a fixed generator, so that a sentence that fails is the same on every run
  const sentencesFrom = (seed: number, count: number): string[] => {
    let state = seed;
    const below = (limit: number): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return Math.floor((state / 2147483648) * limit);
    };
    return Array.from({ length: count }, () => Array.from({ length: 1 + below(16) }, () => WORDS[below(WORDS.length)] ?? '').join(below(5) === 0 ? '' : ' '));
  };

  it('judges some thousands of sentences made of the claim words, clause breaks and quotes, each within its bound', async () => {
    const judged = await judgeEach(held, sentencesFrom(item.length * 7919, 2500), cites, 2000);
    expect(judged).toHaveLength(2500);
  }, 120_000);

  it('judges long repeats of those words within its bound', async () => {
    const units = ['same ', 'But same, ', 'and yet share, ', `differ in ${statusWords}, `, `differ in amountDue (1, `, `differ in amountDue and (`, 'no two ', 'not all ', 'at the top ', 'by far ', 'cannot be named ', 'cannot name the largest ', '"', '( ', ', ', ' . ', 'nothing is ', 'only shared ', `these two ${item}s share a ${holder} `, 'Item A ', 'x '];
    const long = units.flatMap((unit) => ['', ` the same ${statusWords}`, ' share a holder'].map((tail) => `${unit.repeat(Math.ceil(3900 / unit.length))}${tail}`));
    const judged = await judgeEach(held, long, cites, 2000);
    expect(judged).toHaveLength(long.length);
  }, 120_000);

  it('removes a sentence far longer than any answer writes, without reading it', async () => {
    const long = ['these two share a thing ', 'no two ', 'two '].map((unit) => unit.repeat(Math.ceil(128_000 / unit.length)).slice(0, 128_000));
    const judged = await judgeEach(held, long, cites, 500);
    expect(judged).toEqual(long.map(() => ({ kept: 0, reason: 'citation' })));
  }, 60_000);

  it('removes a sentence with dozens of comparison words, which it does not read one by one', async () => {
    const [judged] = await judgeEach(held, [`${`These share the ${statusWords}, `.repeat(30)}.`], cites, 2000);
    expect(judged).toMatchObject({ kept: 0 });
  }, 60_000);
});
