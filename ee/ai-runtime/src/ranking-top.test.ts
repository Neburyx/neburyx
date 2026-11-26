import { describe, expect, it } from 'vitest';
import { removalNoteOf } from './removed-sentences.js';
import { judgeSentences, type CheckedText, type RankedProperty } from './reply-checks.js';

describe.each([
  { type: 'widget', key: 'amountValue', words: 'amount value', rank: 'riskRank', names: ['Item A', 'Item B', 'Item C'] },
  { type: 'filing', key: 'filedTotal', words: 'filed total', rank: 'queueRank', names: ['Case 1', 'Case 2', 'Case 3'] },
])('a ranking written with "top" over $type elements', ({ type, key, words, rank, names }) => {
  const [a = '', b = '', c = ''] = names;
  const all = ['n1', 'n2', 'n3'];
  const build = (values: readonly (string | undefined)[], property: string = key): CheckedText => {
    const keys = values.map((_, index) => `n${index + 1}`);
    const lines = new Map<string, string>(keys.map((id, index) => [id, `${id} | "${type}" | title: "${names[index]}" | id: "${id}x" | ${property}: ${values[index] ?? ''}`]));
    return {
      text: [...lines.values()].join('\n'),
      keys: new Map(keys.map((id) => [id, true])),
      lines,
      inexactCounts: [],
      unknownCountKeys: new Set(),
      elementTypes: new Map(keys.map((id) => [id, `entity ${type}`])),
      elementNames: new Map(keys.map((id, index) => [id, [names[index] ?? '', `${id}x`]])),
      propertyKeys: new Map(keys.map((id) => [id, [property]])),
      rankedValues: new Map<string, readonly RankedProperty[]>(keys.map((id, index) => [id, [{ key: property, dataClass: 'number', ...(values[index] === undefined ? {} : { value: values[index] ?? '' }) }]])),
    };
  };
  const held = build(['900', '10', '75']);
  const verdict = (text: string, over: CheckedText = held, cites: string[] = all): string => {
    const judged = judgeSentences([{ text, cites }], over);
    return judged.kept.length === 1 ? 'kept' : (judged.rejected[0]?.reason ?? 'none');
  };

  it.each([
    `${a} has the top ${key}, 900.`,
    `The top ${words} is 900.`,
    `By ${key}, ${a} tops them.`,
    `By ${key}, ${a} ranks top.`,
    `${a} has the top-ranked ${key}.`,
  ])('keeps the true ranking: %s', (text) => {
    expect(verdict(text)).toBe('kept');
  });

  it.each([
    `${b} has the top ${key}, 10.`,
    `The top ${words} is 75.`,
    `By ${key}, ${c} tops them.`,
    `${a} has the top ${key}, 75.`,
    `${a} is the top ${type}.`,
    `${a} has the top ${key}, 900, and the lowest ${key}.`,
    `${a} is one of the top ${words} holders.`,
    `${a} is in the top ${words}.`,
    `${a} and ${c} have the top three ${words}s.`,
    `${a} is at the top of the list by ${key}, 75.`,
    `${b} is at the top of the table for ${key}.`,
    `${b} is at the top of the list with 10.`,
  ])('removes the false or unproven ranking: %s', (text) => {
    expect(verdict(text)).toBe('comparison');
  });

  it('removes a ranking of two whatever reason is found first', () => {
    expect(verdict(`The top 2 ${words}s are 900 and 75.`)).not.toBe('kept');
  });

  it('removes a tie, an uncited or missing value, and takes the greatest value where one is the best', () => {
    expect(verdict(`${a} has the top ${key}.`, build(['9', '9', '1']))).toBe('comparison');
    expect(verdict(`${a} has the top ${key}.`, build(['9', undefined, '1']))).toBe('comparison');
    expect(verdict(`${a} has the top ${key}.`, held, ['n1', 'n2'])).toBe('comparison');
    expect(verdict(`${a} has the top ${rank}, 1.`, build(['1', '2', '3'], rank))).toBe('comparison');
  });

  it.each([
    `On top of that, ${a} is listed.`,
    `${a} is on top.`,
    `${a} is shown at the top of the list.`,
    `The top row of the table lists ${a}.`,
    `${a} is in the top panel.`,
    `${a} is at the top-left of the view.`,
    `${a} is in the top right corner.`,
    `A top-level view lists ${a}.`,
    `${a} lists a top-up.`,
    `The elements are listed from top to bottom.`,
    `At the top of the view, ${a} shows ${key} 900.`,
    `At the top of the table, ${c} is listed with ${key} 75.`,
    `${c} is at the top of the table, and ${c} has ${key} 75.`,
    `The top-down layout shows ${a} with ${key} 900.`,
    `The note \u201cby far the best\u201d is on ${a}.`,
    `${a} is listed with the note "top ${key}".`,
  ])('judges the ordinary use as before: %s', (text) => {
    expect(judgeSentences([{ text, cites: all }], { ...held, text: `${held.text} "top ${key}" ${a}` }).rejected.map((each) => each.reason)).not.toContain('comparison');
  });

  it('is not misled by an element whose id is a short ordinary word', () => {
    const short = { ...held, elementNames: new Map([...(held.elementNames ?? []), ['n2', ['a']]]) };
    expect(verdict(`${a} has the largest ${key}, 900, by a wide margin.`, short)).toBe('comparison');
  });

  it('reads a long run of the word in a time that grows with its length', () => {
    const started = performance.now();
    verdict(`${a} ${'at the top '.repeat(2000)}`);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('reads no ranking in the name of an element', () => {
    const named = { ...held, elementNames: new Map([...(held.elementNames ?? []), ['n1', [`Top ${key} Group`]]]), text: `${held.text} Top ${key} Group` };
    expect(verdict(`Top ${key} Group is listed.`, named, ['n1'])).toBe('kept');
  });

  it.each([
    `${a} has by far the largest ${key}, 900.`,
    `${a} has the largest ${key}, 900, by far.`,
    `By a wide margin, ${a} has the largest ${key}.`,
    `${a} is far and away the largest ${key}, 900.`,
    `${a} has the largest ${key} by some distance.`,
    `${a} has a much larger ${key} than ${b}.`,
    `${a} has far more than ${b}.`,
    `${a} has a lot more than ${b}.`,
    `The ${words} of ${a} is well above the others.`,
    `${a} dwarfs ${b} in ${words}.`,
    `${a} towers over ${b}.`,
    `${a} has a significantly higher ${words}.`,
  ])('removes words for the size of a gap, though the ranking is right: %s', (text) => {
    expect(verdict(text)).toBe('comparison');
  });

  it.each([
    `${a} has the largest ${key}, 900.`,
    `Much more is not yet retrieved about ${a}.`,
    `${a} is listed, and far more remains to be read.`,
    `So far, ${a} is listed.`,
    `${a} is listed with the note "by far".`,
    `${b} has less ${words} than ${a}.`,
  ])('judges a sentence with no gap claimed as before: %s', (text) => {
    const over = { ...held, text: `${held.text} "by far"` };
    expect(judgeSentences([{ text, cites: all }], over).rejected.map((each) => each.reason)).not.toContain('comparison');
  });

  it('tells the model to state it without the size of the gap and to give the cited values', () => {
    const note = removalNoteOf([{ text: 'T.', reason: 'comparison' }]);
    expect(note).toContain('without words for how large the gap is');
    expect(note).toContain('give the cited values');
  });
});
