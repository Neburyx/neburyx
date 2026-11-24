import { describe, expect, it } from 'vitest';
import { rankingBroken } from './checks.js';
import { replyOf, startRig } from './testing/rig.js';
import { node, prop, reading } from './view.js';

interface Vocabulary {
  readonly type: string;
  readonly amount: string;
  readonly time: string;
  readonly ids: readonly string[];
  readonly titles: readonly string[];
}

const VOCABULARIES: readonly Vocabulary[] = [
  { type: 'widget', amount: 'amountValue', time: 'seenAt', ids: ['W-1', 'W-2', 'W-3', 'W-4', 'W-5'], titles: ['Item A', 'Item B', 'Item C', 'Item D', 'Item E'] },
  { type: 'claim', amount: 'claimedAmount', time: 'filedOn', ids: ['C-1', 'C-2', 'C-3', 'C-4', 'C-5'], titles: ['Case 1', 'Case 2', 'Case 3', 'Case 4', 'Case 5'] },
];

const AMOUNTS = ['10', '2', '30', '5', '8'];
const INSTANTS = ['2022-09-10T23:57:00Z', '2022-09-10T23:58:00Z', '2022-09-10T23:55:00Z', '2022-09-10T23:56:00Z', '2022-09-10T23:50:00Z'];

describe.each(VOCABULARIES)('the suite\'s own rule for a ranking, and the product, over a set named in full and a property written first: $type', ({ type, amount, time, ids, titles }) => {
  const [a = '', b = '', c = '', d = ''] = titles;
  const view = reading(ids.map((id, index) => node(type, id, titles[index] ?? '', [prop(amount, Number(AMOUNTS[index]), false, 'number'), prop(time, INSTANTS[index], false, 'dateTime')])));
  const classes = new Map([[amount, 'number'], [time, 'dateTime']]);

  async function both(text: string, citedIds: readonly string[]): Promise<{ readonly kept: boolean; readonly broken: boolean }> {
    const probe = startRig({ replies: [replyOf()], settings: { maxCalls: 1 } });
    await probe.summarize(view);
    const sent = probe.requests[0]?.values ?? '';
    const keyOf = (id: string): string => /^(n\d+) \|/u.exec(sent.split('\n').find((line) => line.includes(`id: "${id}"`)) ?? '')?.[1] ?? 'none';
    const cites = citedIds.map(keyOf);
    const rig = startRig({ replies: [replyOf({ text, cites })], settings: { maxCalls: 1 } });
    await rig.summarize(view);
    return { kept: (rig.store.runs[0]?.removals.length ?? 0) === 0, broken: rankingBroken({ text, cites }, sent, classes) };
  }

  it.each([
    ['the latest of a named set, the instant said', () => `By ${time}, the latest of ${a}, ${b} and ${d} is ${b}, at 2022-09-10T23:58:00Z.`, [0, 1, 3], true],
    ['the latest of a named set, with the property written before the word', () => `${b} has ${time} 2022-09-10T23:58:00Z, the latest of ${a}, ${b} and ${d}.`, [0, 1, 3], true],
    ['the largest of a named set among others in view', () => `Among ${a}, ${b} and ${c}, ${c} has the largest ${amount}, 30.`, [0, 1, 2], true],
    ['the largest of the whole type, with the property written before the word', () => `${c} has ${amount} 30, the largest of the ${type}s.`, [0, 1, 2, 3, 4], true],
    ['the wrong element of a named set', () => `By ${time}, the latest of ${a}, ${b} and ${d} is ${a}, at 2022-09-10T23:57:00Z.`, [0, 1, 3], false],
    ['a named set with an element that is not cited', () => `By ${time}, the latest of ${a}, ${b} and ${d} is ${b}, at 2022-09-10T23:58:00Z.`, [0, 1], false],
    ['a set that is only one element', () => `By ${time}, the latest of ${a} is ${a}.`, [0], false],
    ['the largest of the type with an element left uncited, the property written before the word', () => `${c} has ${amount} 30, the largest of the ${type}s.`, [0, 1, 2], false],
    ['a property written before the word that is not the extreme', () => `${a} has ${amount} 10, the largest of the ${type}s.`, [0, 1, 2, 3, 4], false],
  ] as const)('judges %s alike', async (_name, text, indexes, expected) => {
    const outcome = await both(text(), indexes.map((index) => ids[index] ?? ''));
    expect(outcome.kept).toBe(expected);
    expect(outcome.broken).toBe(!expected);
  });
});
