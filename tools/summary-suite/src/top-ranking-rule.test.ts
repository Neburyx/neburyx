import type { SummarySentence } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { judgeSentences, type CheckedText } from '../../../ee/ai-runtime/src/reply-checks.js';
import { assembleText } from '../../../ee/ask/src/case-summary/assemble.js';
import { checkedTextOf } from '../../../ee/ask/src/case-summary/judge.js';
import { mutatedChecks, type Mutation } from './mutants.js';
import { node, prop, reading } from './view.js';

type Judge = (sentences: readonly SummarySentence[], text: CheckedText) => { readonly kept: readonly SummarySentence[] };

const NO_TOP: Mutation = { name: 'the top rankings', from: ', ...rankingTopsIn(text)]', to: ']' };
const NO_GAP: Mutation = { name: 'the words for the size of a gap', from: '&& gapClaimsHold(sentence, assembled) && comparisonClaimsHold', to: '&& comparisonClaimsHold' };

describe.each([
  { pack: 'banking-fraud', item: 'transaction', property: 'amount' },
  { pack: 'insurance-claims', item: 'claim', property: 'amountClaimed' },
])('false "top" and "by far" sentences made from true ones are removed ($pack)', ({ item, property }) => {
  const text = checkedTextOf(assembleText(reading([['A', 900], ['B', 10], ['C', 75]].map(([id, value]) => node(item, String(id), `Item ${id}`, [prop(property, value, false, 'number')])))));
  const keys = [...(text.elementTypes?.keys() ?? [])];
  const said = (sentence: string): SummarySentence => ({ text: sentence, cites: keys });
  const kept = (sentence: string): boolean => judgeSentences([said(sentence)], text).kept.length === 1;

  const TRUE = [`Item A has the top ${property}, 900.`, `By ${property}, Item A tops them.`, `Item A has the largest ${property}, 900.`];
  const FALSE_TOP = [`Item B has the top ${property}, 10.`, `By ${property}, Item C tops them.`, `Item A has the top ${property}, 75.`];
  const GAPS = [`Item A has by far the largest ${property}, 900.`, `Item A has the top ${property}, 900, by a wide margin.`, `Item A has a much larger ${property} than Item B.`];

  it.each(TRUE)('keeps the true sentence: %s', (sentence) => {
    expect(kept(sentence)).toBe(true);
  });

  it.each([...FALSE_TOP, ...GAPS])('removes: %s', (sentence) => {
    expect(kept(sentence)).toBe(false);
  });

  it.each([
    [NO_TOP, FALSE_TOP[0] ?? ''],
    [NO_GAP, GAPS[0] ?? ''],
  ] as const)('keeps it again once $0.name are taken out of the product', async (mutation, sentence) => {
    const judge = (await mutatedChecks(mutation))['judgeSentences'] as Judge;
    expect(judge([said(sentence)], text).kept).toHaveLength(1);
  });
});

describe.each([
  { pack: 'banking-fraud', item: 'transaction', property: 'amount' },
  { pack: 'insurance-claims', item: 'claim', property: 'amountClaimed' },
])('honest limits kept and the claims made from them removed ($pack)', ({ item, property }) => {
  const base = checkedTextOf(assembleText(reading([['A', 900], ['B', 10], ['C', 75]].map(([id, value]) => node(item, String(id), `Item ${id}`, [prop(property, value, false, 'number')])))));
  const text: CheckedText = { ...base, lines: new Map([...base.lines, ['s1', 's1: read of lookup: 3 matches shown · lower bound']]), keys: new Map([...base.keys, ['s1', true]]), readKeys: new Set(['s1']), readElements: new Map([['s1', [...(base.elementTypes?.keys() ?? [])]]]) };
  const said = (sentence: string): SummarySentence => ({ text: sentence, cites: [...(base.elementTypes?.keys() ?? []), 's1'] });
  const kept = (sentence: string): boolean => judgeSentences([said(sentence)], text).kept.length === 1;

  const LIMITS = [`This does not hold for all of the ${item}s.`, `The largest cannot be named from the read.`, `I cannot identify the largest of the ${item}s.`, `Item A has the top ${property}, 900, and this does not hold for every ${item}.`];
  const CLAIMS = [`Item B has the largest ${property}, 10.`, `The smallest cannot be named, but Item B has the largest ${property}, 10.`, `The smallest cannot be named and Item B has the largest ${property}.`, `The read does not list all of the ${item}s, and Item B has the top ${property}.`, `Item B comes out on top with ${property} 10.`];

  it.each(LIMITS)('keeps the limit: %s', (sentence) => {
    expect(kept(sentence)).toBe(true);
  });

  it.each(CLAIMS)('removes the false claim beside it: %s', (sentence) => {
    expect(kept(sentence)).toBe(false);
  });

  it.each([
    [{ name: 'the denial of a claim about all', from: 'if (DENIED_ALL.test(before)) continue;', to: '' }, `This does not hold for all of the ${item}s.`],
    [{ name: 'the refusal to rank', from: ' && !refusesToRank(text, written, claim)', to: '' }, 'The largest cannot be named from the read.'],
  ] as const)('removes a limit again once its rule is taken out of the product: %o', async (mutation, sentence) => {
    // the read alone is cited: the set the sentence speaks of is not
    const limit: SummarySentence = { text: sentence, cites: ['s1'] };
    expect(judgeSentences([limit], text).kept).toHaveLength(1);
    const judge = (await mutatedChecks(mutation))['judgeSentences'] as Judge;
    expect(judge([limit], text).kept).toHaveLength(0);
  });
});
