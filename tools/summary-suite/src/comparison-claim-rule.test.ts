import type { SummarySentence } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { judgeSentences, type CheckedText } from '../../../ee/ai-runtime/src/reply-checks.js';
import { mutatedChecks, type Mutation } from './mutants.js';

type Judge = (sentences: readonly SummarySentence[], text: CheckedText) => { readonly kept: readonly SummarySentence[] };

const NO_COMPARISON_CLAIMS: Mutation = { name: 'the rule of comparison claims', from: '&& comparisonClaimsHold(sentence, assembled) && claimsAreBacked', to: '&& claimsAreBacked' };

describe.each([
  { pack: 'banking-fraud', item: 'transaction', holder: 'account', link: 'PAID_TO' },
  { pack: 'insurance-claims', item: 'claim', holder: 'repairer', link: 'REPAIRED_BY' },
])('the rule of comparison claims taken out of the product leaves a false claim that the suite catches ($pack)', ({ item, holder, link }) => {
  const elements = [
    ['r1', `entity ${item}`, 'Item A', 'alpha'],
    ['r2', `entity ${item}`, 'Item B', 'beta'],
    ['r3', `entity ${holder}`, 'Holder C', undefined],
    ['r4', `entity ${holder}`, 'Holder D', undefined],
  ] as const;
  const links = [['r5', 'r1', 'r3'], ['r6', 'r2', 'r4']] as const;
  const lines = new Map<string, string>([...elements.map(([key, , title, kind]) => [key, `${key}: ${title}${kind === undefined ? '' : ` | kind: "${kind}"`}`] as const), ...links.map(([key]) => [key, `${key}: ${link}`] as const)]);
  const end = (key: string): readonly [string, string] => {
    const found = elements.find(([own]) => own === key);
    return [found?.[1].slice('entity '.length) ?? '', found?.[2] ?? ''];
  };
  const text: CheckedText = {
    text: [...lines.values()].join('\n'),
    keys: new Map([...lines.keys()].map((key) => [key, true])),
    lines,
    inexactCounts: [],
    unknownCountKeys: new Set(),
    elementTypes: new Map<string, string>([...elements.map(([key, type]) => [key, type] as const), ...links.map(([key]) => [key, `relationship ${link}`] as const)]),
    elementNames: new Map(elements.map(([key, , title]) => [key, [title]])),
    elementEnds: new Map<string, readonly (readonly [string, string])[]>([...elements.map(([key]) => [key, [end(key)]] as const), ...links.map(([key, from, to]) => [key, [end(from), end(to)]] as const)]),
    rankedValues: new Map(elements.flatMap(([key, , , kind]) => (kind === undefined ? [] : [[key, [{ key: 'kind', dataClass: 'text' }]] as const]))),
    elementValues: new Map(elements.flatMap(([key, , , kind]) => (kind === undefined ? [] : [[key, [{ key: 'kind', text: kind, masked: false }]] as const]))),
  };

  const CASES: readonly (readonly [string, SummarySentence])[] = [
    ['a false sameness of a property', { text: 'These two have the same kind.', cites: ['r1', 'r2'] }],
    ['a false shared connected element', { text: `These two ${item}s share a ${holder}.`, cites: ['r5', 'r6'] }],
    ['a claim the check cannot test', { text: 'These two are alike.', cites: ['r1', 'r2'] }],
  ];

  it.each(CASES)('removes %s, and keeps it with the rule taken out', async (_name, sentence) => {
    expect(judgeSentences([sentence], text).kept).toEqual([]);
    const judge = (await mutatedChecks(NO_COMPARISON_CLAIMS))['judgeSentences'] as Judge;
    expect(judge([sentence], text).kept).toHaveLength(1);
  });

  it('keeps a true difference with the product as it is', () => {
    expect(judgeSentences([{ text: 'These two have different kinds.', cites: ['r1', 'r2'] }], text).kept).toHaveLength(1);
  });
});
