import type { GraphEdge, GraphNode } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { judgeSentences, type CheckedText } from '../../../ee/ai-runtime/src/reply-checks.js';
import { assembleText } from '../../../ee/ask/src/case-summary/assemble.js';
import { checkedTextOf } from '../../../ee/ask/src/case-summary/judge.js';
import { edge, node, prop, reading } from './view.js';

/** The words of two mappings: an item, the holder that sends it and the holder that receives it. */
const PACKS = [
  { pack: 'banking-fraud', item: 'transaction', holder: 'account', send: 'INITIATED', sender: 'initiating', receive: 'PAID_TO', receiver: 'paid', property: 'channel', words: 'channel' },
  { pack: 'insurance-claims', item: 'claim', holder: 'repairer', send: 'FILED', sender: 'filing', receive: 'REPAIRED_BY', receiver: 'repairing', property: 'lossType', words: 'loss type' },
] as const;

/** What an evidence holds: who each item came from and went to, its property value, and what a read said of the receiving links. */
interface World {
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly extra: readonly (readonly [item: number, holder: string])[];
  readonly values: readonly string[];
  readonly masked?: number;
  readonly read?: string;
}

/** A true sentence with the evidence that shows it, what it cites, and the changes of the evidence that leave it false or unproven. */
interface Case {
  readonly sentence: string;
  readonly cites: 'sends' | 'receives' | 'all' | 'items';
  readonly world: World;
  readonly mutants: Readonly<Record<string, World>>;
}

const BASE: World = { from: ['Gamma', 'Gamma', 'Gamma'], to: ['Delta', 'Epsilon', 'Zeta'], extra: [], values: ['alpha', 'alpha', 'alpha'] };
const SPREAD: World = { ...BASE, values: ['alpha', 'beta', 'delta'] };
const ITEMS = ['A', 'B', 'C'] as const;

describe.each(PACKS)('false comparison claims made from true ones are removed ($pack)', (pack) => {
  const { item, holder } = pack;
  const ref = (type: string, id: string): GraphNode['ref'] => ({ sourceId: 'demo', entityType: type, stableId: id });

  function judged(world: World, sentence: string, which: 'sends' | 'receives' | 'all' | 'items'): boolean {
    const holders = [...new Set([...world.from, ...world.to, ...world.extra.map(([, name]) => name)])];
    const nodes = [...ITEMS.map((id, index) => node(item, id, `Item ${id}`, [prop(pack.property, world.masked === index ? 'a***' : world.values[index], world.masked === index)])), ...holders.map((name) => node(holder, name, name))];
    const link = (type: string, id: string, from: GraphNode['ref'], to: GraphNode['ref']): GraphEdge => edge(type, id, from, to);
    const sends = world.from.map((name, index) => link(pack.send, `s${index}`, ref(holder, name), ref(item, ITEMS[index] ?? '')));
    const receives = [...world.to.map((name, index) => link(pack.receive, `t${index}`, ref(item, ITEMS[index] ?? ''), ref(holder, name))), ...world.extra.map(([index, name], at) => link(pack.receive, `x${at}`, ref(item, ITEMS[index] ?? ''), ref(holder, name)))];
    const text = assembleText(reading(nodes, [...sends, ...receives]));
    const keyOf = (stableId: string): string => [...text.keys].find(([, element]) => JSON.stringify(element.ref).includes(`"${stableId}"`) && element.kind === 'relationship')?.[0] ?? '';
    const sendKeys = sends.map((each) => keyOf((each.ref as { stableId: string }).stableId));
    const receiveKeys = receives.map((each) => keyOf((each.ref as { stableId: string }).stableId));
    const itemKeys = [...text.keys].filter(([, element]) => element.kind === 'entity' && element.ref.entityType === item).map(([key]) => key);
    const cites = which === 'sends' ? sendKeys : which === 'receives' ? receiveKeys : which === 'all' ? [...sendKeys, ...receiveKeys] : itemKeys;
    expect(cites.every((key) => key !== '')).toBe(true);
    let checked: CheckedText = checkedTextOf(text);
    if (world.read !== undefined) checked = { ...checked, lines: new Map([...checked.lines, ['s1', `s1: read of lookup: ${world.read}`]]), readKeys: new Set(['s1']), readElements: new Map([['s1', receiveKeys]]) };
    return judgeSentences([{ text: sentence, cites }], checked).kept.length === 1;
  }

  const role = pack.receiver;
  const CASES: readonly Case[] = [
    {
      sentence: `These three have the same ${pack.words}.`,
      cites: 'items',
      world: BASE,
      mutants: { 'one value swapped': { ...BASE, values: ['alpha', 'beta', 'alpha'] }, 'one value masked': { ...BASE, masked: 1 } },
    },
    {
      sentence: `These three have different ${pack.words}s.`,
      cites: 'items',
      world: SPREAD,
      mutants: { 'one value made equal': { ...SPREAD, values: ['alpha', 'alpha', 'delta'] }, 'one value masked': { ...SPREAD, masked: 2 } },
    },
    {
      sentence: `These three share a ${pack.sender} ${holder}.`,
      cites: 'sends',
      world: BASE,
      mutants: { 'one sender swapped': { ...BASE, from: ['Gamma', 'Theta', 'Gamma'] } },
    },
    {
      sentence: `These three have the same ${pack.sender} ${holder}, Gamma.`,
      cites: 'sends',
      world: BASE,
      mutants: { 'every sender swapped for another': { ...BASE, from: ['Theta', 'Theta', 'Theta'] }, 'one sender swapped': { ...BASE, from: ['Gamma', 'Gamma', 'Theta'] } },
    },
    ...[`None of these three share a ${role} ${holder}`, `These three have different ${role} ${holder}s`].flatMap((claim): Case[] => [
      {
        sentence: `${claim} among those read.`,
        cites: 'receives',
        world: { ...BASE, read: '3 matches shown · exact' },
        mutants: {
          'one holder swapped for another’s': { ...BASE, to: ['Delta', 'Delta', 'Zeta'], read: '3 matches shown · exact' },
          'a shared holder added': { ...BASE, extra: [[0, 'Epsilon']] as const, read: '4 matches shown · exact' },
          'a lower-bound read': { ...BASE, read: '3 matches shown · lower bound' },
        },
      },
      {
        sentence: `${claim}.`,
        cites: 'receives',
        world: BASE,
        mutants: { 'a read that may have been filtered': { ...BASE, read: '3 matches shown · exact' }, 'a lower-bound read': { ...BASE, read: '3 matches shown · lower bound' } },
      },
    ]),
    {
      sentence: `The only shared ${holder} among those read is Gamma.`,
      cites: 'all',
      world: { ...BASE, read: '3 matches shown · exact' },
      mutants: {
        'a second shared holder added': { ...BASE, extra: [[0, 'Epsilon']] as const, read: '4 matches shown · exact' },
        'the named holder swapped': { ...BASE, from: ['Theta', 'Theta', 'Theta'], read: '3 matches shown · exact' },
        'a lower-bound read': { ...BASE, read: '3 matches shown · lower bound' },
      },
    },
  ];

  const mutants = CASES.flatMap((each) => Object.entries(each.mutants).map(([change, world]) => [each.sentence, change, each.cites, world] as const));

  it.each(CASES.map((each) => [each.sentence, each] as const))('keeps the true sentence: %s', (_sentence, each) => {
    expect(judged(each.world, each.sentence, each.cites)).toBe(true);
  });

  it.each(mutants)('removes it once the evidence changes: %s (%s)', (sentence, _change, cites, world) => {
    expect(judged(world, sentence, cites)).toBe(false);
  });

  it(`catches all ${mutants.length} false sentences made from ${CASES.length} true ones`, () => {
    expect(mutants.filter(([sentence, , cites, world]) => !judged(world, sentence, cites))).toHaveLength(mutants.length);
    expect(mutants.length).toBe(20);
  });
});
