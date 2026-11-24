import { describe, expect, it } from 'vitest';
import { judgeSentences, temporalKey, type CheckedText, type RankedProperty, type RemovalReason } from './reply-checks.js';

const vocabularies = [
  { type: 'widget', many: 'widgets', other: 'gadget', others: 'gadgets', amount: 'amountValue', time: 'seenAt', link: 'SENT', titles: ['Item A', 'Item B', 'Item C', 'Item D', 'Item E'], holders: ['Holder X', 'Holder Y', 'Holder Z'] },
  { type: 'claim', many: 'claims', other: 'policy', others: 'policies', amount: 'claimedAmount', time: 'filedOn', link: 'FILED_BY', titles: ['Case 1', 'Case 2', 'Case 3', 'Case 4', 'Case 5'], holders: ['Cover X', 'Cover Y', 'Cover Z'] },
] as const;

const INSTANTS = ['2022-09-10T23:57:00Z', '2022-09-10T23:58:00Z', '2022-09-10T23:55:00Z', '2022-09-10T23:56:00Z', '2022-09-10T23:50:00Z'];

describe.each(vocabularies)('claims limited to a set they can be checked against, over $type elements', ({ type, many, other, others, amount, time, link, titles, holders }) => {
  const [a = '', b = '', c = '', d = '', e = ''] = titles;
  // the view holds n1..n5 (the five a view lists) and a read listed r1..r3 of the same type, with amounts; three more of another type are in view
  const amounts = ['10', '2', '30', '5', '8'];
  const readAmounts = ['40', '7', '15'];
  const readTitles = ['Item P', 'Item Q', 'Item R'];
  const build = (over: { readonly readValues?: readonly string[]; readonly viewTimes?: readonly string[] } = {}): CheckedText => {
    const lines = new Map<string, string>();
    const ranked = new Map<string, readonly RankedProperty[]>();
    const kinds = new Map<string, string>();
    const keysOfProperties = new Map<string, readonly string[]>();
    const viewTimes = over.viewTimes ?? INSTANTS;
    ['n1', 'n2', 'n3', 'n4', 'n5'].forEach((id, index) => {
      lines.set(id, `${id} | "${type}" | title: "${titles[index]}" | id: "${id}x" | ${amount}: ${amounts[index]}; ${time}: "${viewTimes[index]}"`);
      ranked.set(id, [{ key: amount, dataClass: 'number', value: amounts[index] ?? '' }, { key: time, dataClass: 'dateTime', value: temporalKey('dateTime', viewTimes[index] ?? '') ?? '' }]);
      kinds.set(id, `entity ${type}`);
      keysOfProperties.set(id, [amount, time]);
    });
    (over.readValues ?? readAmounts).forEach((value, index) => {
      const id = `r${index + 1}`;
      lines.set(id, `${id}: ${type}: ${readTitles[index]} | ${amount}: ${value}`);
      ranked.set(id, [{ key: amount, dataClass: 'number', value }]);
      kinds.set(id, `entity ${type}`);
      keysOfProperties.set(id, [amount]);
    });
    holders.forEach((title, index) => {
      const id = `n${index + 6}`;
      lines.set(id, `${id} | "${other}" | title: "${title}" | id: "${id}x"`);
      kinds.set(id, `entity ${other}`);
      keysOfProperties.set(id, []);
      ranked.set(id, []);
    });
    lines.set('e1', `e1 | "${link}" | n1 -> n6`);
    kinds.set('e1', `relationship ${link}`);
    lines.set('s1', 's1: read of lookup: 3 matches shown · lower bound');
    lines.set('c1', 'c1: view coverage: 8 entities shown · 0 relationships shown · ≥ 9 not yet retrieved (lower bound)');
    return {
      text: [...lines.values()].join('\n'),
      keys: new Map([...lines.keys()].map((id) => [id, true])),
      lines,
      inexactCounts: [],
      unknownCountKeys: new Set(),
      elementTypes: kinds,
      propertyKeys: keysOfProperties,
      readKeys: new Set(['s1', 'c1']),
      readElements: new Map([['s1', ['r1', 'r2', 'r3']]]),
      rankedValues: ranked,
    };
  };
  const verdict = (text: string, cites: string[], held: CheckedText = build()): 'kept' | RemovalReason | 'none' => {
    const judged = judgeSentences([{ text, cites }], held);
    return judged.kept.length === 1 ? 'kept' : (judged.rejected[0]?.reason ?? 'none');
  };
  const read = ['r1', 'r2', 'r3'];
  const all = ['n1', 'n2', 'n3', 'n4', 'n5'];

  describe('a ranking over what one read listed', () => {
    it('keeps the largest of the read that the sentence speaks of, with the property written before or after the ranking word', () => {
      expect(verdict(`${readTitles[0]} has ${amount} 40, the largest among the ${many} shown in the read.`, read)).toBe('kept');
      expect(verdict(`Among the ${many} the read shows, the largest ${amount} is 40, on ${readTitles[0]}.`, [...read, 's1'])).toBe('kept');
      expect(verdict(`${readTitles[1]} has the smallest ${amount}, 7, of the ${many} in the read.`, read)).toBe('kept');
    });

    it('removes it when the element or the figure is not the extreme of the read, or a tie, or an element of the read is left uncited', () => {
      expect(verdict(`${readTitles[1]} has ${amount} 7, the largest among the ${many} shown in the read.`, read)).toBe('comparison');
      expect(verdict(`${readTitles[0]} has ${amount} 15, the largest among the ${many} shown in the read.`, read)).toBe('comparison');
      expect(verdict(`${readTitles[0]} has ${amount} 40, the largest among the ${many} shown in the read.`, ['r1', 'r2'])).toBe('comparison');
      expect(verdict(`${readTitles[0]} has ${amount} 40, the largest among the ${many} shown in the read.`, read, build({ readValues: ['40', '7', '40'] }))).toBe('comparison');
    });

    it('does not limit a ranking to a read the sentence does not speak of: the elements of the view of the same type are then in the set', () => {
      expect(verdict(`${readTitles[0]} has the largest ${amount}, 40.`, read)).toBe('comparison');
      expect(verdict(`${readTitles[0]} has ${amount} 40, the largest of the ${many}.`, read)).toBe('comparison');
    });

    it('does not take the citation of the line of a read, or a word of result, for a limit to the read', () => {
      expect(verdict(`${readTitles[0]} has the largest ${amount}, 40.`, [...read, 's1'])).toBe('comparison');
      expect(verdict(`As a result, ${readTitles[0]} has the largest ${amount}, 40.`, read)).toBe('comparison');
      expect(verdict(`${readTitles[0]} has the largest ${amount}, 40; ${readTitles[0]} is also in the read.`, [...read, 's1'])).toBe('comparison');
      for (const text of [
        `${readTitles[0]} has the largest ${amount}, 40, also shown in the read.`,
        `${readTitles[0]} has the largest ${amount}, 40, found in the read.`,
        `${readTitles[0]} is in the read, so ${readTitles[0]} has the largest ${amount}, 40.`,
        `${readTitles[0]} is in the read - it has the largest ${amount}, 40.`,
        `${readTitles[0]}, from the read, has the largest ${amount}, 40.`,
        `${readTitles[0]}, listed in the read, has the largest ${amount}, 40.`,
      ]) expect(verdict(text, [...read, 's1'])).toBe('comparison');
    });

    it('keeps the largest of the read when the read is named right after the property or opens the sentence', () => {
      expect(verdict(`${readTitles[0]} has the largest ${amount} in the read, 40.`, read)).toBe('kept');
      expect(verdict(`In the read, ${readTitles[0]} has the largest ${amount}, 40.`, read)).toBe('kept');
    });

    it('does not take a read phrase that something widens, inverts or adds to for the limit', () => {
      for (const text of [
        `${readTitles[0]} has the largest ${amount} of the ${many} in the read and in the view, 40.`,
        `${readTitles[0]} has the largest ${amount} of the ${many} in the read or elsewhere, 40.`,
        `${readTitles[0]} has the largest ${amount} of the ${many} not in the read, 40.`,
        `${readTitles[0]} has the largest ${amount} of the ${many} besides those in the read, 40.`,
        `${readTitles[0]} has the largest ${amount} of the ${many} except those in the read, 40.`,
        `In the read, ${readTitles[0]} has the largest ${amount}, 40, of any ${type} in the view.`,
      ]) expect(verdict(text, read)).toBe('comparison');
    });

    it('does not keep the limit when a tail after the scope opens another set or claims beyond it', () => {
      for (const text of [
        `${readTitles[0]} has the largest ${amount} in the read, and in the view, 40.`,
        `${readTitles[0]} has the largest ${amount} of the ${many} in the read, and elsewhere, 40.`,
        `${readTitles[0]} has the largest ${amount} of the ${many} in the read, 40, as it is in the view.`,
        `In the read, ${readTitles[0]} has the largest ${amount}, 40, more than any ${type} shown.`,
      ]) expect(verdict(text, read)).toBe('comparison');
    });

    it('does not limit it when two reads listed the elements cited, since the read it means is not known', () => {
      const held = build();
      const twice: CheckedText = { ...held, readKeys: new Set([...(held.readKeys ?? []), 's2']), readElements: new Map([...(held.readElements ?? []), ['s2', ['r1', 'r2', 'r3']]]), lines: new Map([...held.lines, ['s2', 's2: read of other: 3 matches shown · exact']]) };
      expect(verdict(`${readTitles[0]} has ${amount} 40, the largest among the ${many} shown in the read.`, read, twice)).toBe('comparison');
    });
  });

  describe('a ranking over the elements the sentence names in full', () => {
    const listed = `${a}, ${b}, ${c}, ${d} and ${e}`;
    it('keeps the latest or the largest of a list that names every cited element, wherever the property is written', () => {
      expect(verdict(`By ${time}, the latest of ${a}, ${b} and ${d} is ${b}, at 2022-09-10T23:58:00Z.`, ['n1', 'n2', 'n4'])).toBe('kept');
      expect(verdict(`The latest ${time} among ${a}, ${c} and ${d} is 2022-09-10T23:57:00Z, on ${a}.`, ['n1', 'n3', 'n4'])).toBe('kept');
      expect(verdict(`Among ${a}, ${b} and ${c}, ${c} has the largest ${amount}, 30.`, ['n1', 'n2', 'n3'])).toBe('kept');
      expect(verdict(`By ${amount}, the largest of ${listed} is ${c}, 30.`, all)).toBe('kept');
    });

    it('removes it for the wrong element or figure, a tie, an element of the list that is not cited, and a list of one', () => {
      expect(verdict(`By ${time}, the latest of ${a}, ${b} and ${d} is ${a}, at 2022-09-10T23:57:00Z.`, ['n1', 'n2', 'n4'])).not.toBe('kept');
      expect(verdict(`By ${time}, the latest of ${a}, ${b} and ${d} is ${b}, at 2022-09-10T23:57:00Z.`, ['n1', 'n2', 'n4'])).not.toBe('kept');
      expect(verdict(`By ${time}, the latest of ${a}, ${b} and ${d} is ${b}, at 2022-09-10T23:58:00Z.`, ['n1', 'n2'])).not.toBe('kept');
      expect(verdict(`By ${time}, the latest of ${a} is ${a}.`, ['n1'])).not.toBe('kept');
      expect(verdict(`By ${time}, the latest of ${a}, ${b} and ${d} is ${b}.`, ['n1', 'n2', 'n4'], build({ viewTimes: ['2022-09-10T23:57:00Z', '2022-09-10T23:58:00Z', '2022-09-10T23:55:00Z', '2022-09-10T23:58:00Z', '2022-09-10T23:50:00Z'] }))).not.toBe('kept');
    });

    it('does not take a list that stands elsewhere in the sentence for the set of the ranking', () => {
      expect(verdict(`${a} has the largest ${amount}, 10; the sender of ${a} and ${b} is ${holders[0]}.`, ['n1', 'n2', 'n6'])).not.toBe('kept');
      expect(verdict(`${a} has the largest ${amount}, 10, and is one of ${a} and ${b}.`, ['n1', 'n2'])).not.toBe('kept');
      expect(verdict(`${holders[0]} sent both of ${a} and ${b}, and ${a} has the largest ${amount}, 10.`, ['n1', 'n2', 'n6'])).not.toBe('kept');
      expect(verdict(`${holders[0]} sent both of ${a} and ${b}, but ${a} has the largest ${amount}, 10.`, ['n1', 'n2', 'n6'])).not.toBe('kept');
      for (const joiner of ['so', 'then', 'thus', 'therefore', 'yet', '']) expect(verdict(`${holders[0]} sent both of ${a} and ${b}, ${joiner} ${a} has the largest ${amount}, 10.`, ['n1', 'n2', 'n6'])).not.toBe('kept');
      expect(verdict(`${a}, one of ${a} and ${b}, has the largest ${amount}, 10.`, ['n1', 'n2'])).not.toBe('kept');
      expect(verdict(`${a}, among ${a} and ${b}, has the largest ${amount}, 10.`, ['n1', 'n2'])).not.toBe('kept');
    });

    it('does not take a list that something widens or adds to for the set', () => {
      for (const text of [
        `${a} has the largest ${amount} of ${a}, ${b} and the rest, 10.`,
        `${a} has the largest ${amount} of ${a} and ${b} and the others, 10.`,
        `${a} has the largest ${amount} of ${a} and ${b} or any ${type} in the view, 10.`,
        `Of ${a} and ${b}, ${a} has the largest ${amount}, 10, of any ${type} in the view.`,
      ]) expect(verdict(text, ['n1', 'n2'])).not.toBe('kept');
    });

    it('does not keep the set when a tail after the list opens another set or claims beyond it', () => {
      for (const text of [
        `${a} has the largest ${amount} of ${a} and ${b}, 10, and of any ${type} in the view.`,
        `${a} has the largest ${amount} of ${a} and ${b}, 10, and of the rest too.`,
        `${a} has the largest ${amount} of ${a} and ${b}, 10, more than any ${type} shown.`,
        `The largest ${amount} of ${a} and ${b} is 10, and that holds for the rest too.`,
        `The largest ${amount} of ${a} and ${b} is held by ${a}, as in the whole view.`,
      ]) expect(verdict(text, ['n1', 'n2'])).not.toBe('kept');
    });

    it('does not take a list for the whole type when it names none of the ranking: the latest of the elements, with no list, is over every one of them', () => {
      expect(verdict(`By ${time}, the latest of the three ${many} is ${b}, at 2022-09-10T23:58:00Z.`, ['n1', 'n2', 'n4'])).toBe('comparison');
    });
  });

  describe('a sentence that says what is left of a set whose sentence was removed', () => {
    const removed = { text: `By ${time}, the latest of the three ${many} is ${b}, at 2022-09-10T23:58:00Z.`, cites: ['n1', 'n2', 'n4'] };
    const rest = { text: `The other two have earlier ${time}: ${a} at 2022-09-10T23:57:00Z and ${d} at 2022-09-10T23:56:00Z.`, cites: ['n1', 'n4'] };

    it('is removed with it, with the reason of the sentence it rests on', () => {
      const judged = judgeSentences([removed, rest], build());
      expect(judged.kept).toEqual([]);
      expect(judged.rejected.map((each) => each.reason)).toEqual(['comparison', 'comparison']);
    });

    it('is removed after a sentence removed for a verdict, and after a dependent that was removed, and only when the sentence before it was removed', () => {
      const verdictSentence = { text: `${a} is guilty of fraud.`, cites: ['n1', 'n2'] };
      const left = { text: `The other ${many} include ${b}.`, cites: ['n2'] };
      expect(judgeSentences([verdictSentence, left], build()).kept).toEqual([]);
      const chain = judgeSentences([removed, rest, { text: `The rest have ${amount} below 30: ${d} has 5.`, cites: ['n4'] }], build());
      expect(chain.kept).toEqual([]);
      const good = { text: `${c} has ${amount} 30.`, cites: ['n3'] };
      expect(judgeSentences([removed, good, rest], build()).kept).toEqual([good, rest]);
    });

    it('is kept when the sentence it rests on is kept, or when it shares no element with the removed one, or opens on a set of its own', () => {
      const good = { text: `By ${time}, the latest of ${a}, ${b} and ${d} is ${b}, at 2022-09-10T23:58:00Z.`, cites: ['n1', 'n2', 'n4'] };
      expect(judgeSentences([good, rest], build()).kept).toHaveLength(2);
      expect(judgeSentences([removed, { text: `The other ${type} ${c} has ${amount} 30.`, cites: ['n3'] }], build()).kept).toHaveLength(1);
      expect(judgeSentences([removed, { text: `${a} and ${d} have earlier ${time} than ${b}.`, cites: ['n1', 'n4'] }], build()).rejected.map((each) => each.reason)).not.toContain('citation');
    });
  });

  describe('the universal only', () => {
    const states = (text: string, cites: string[]): 'kept' | RemovalReason | 'none' => verdict(text, cites);

    it('removes `the only` and `only` over a set that the sentence does not cite whole, and over a set of more than one', () => {
      expect(states(`The only ${other} shown is ${holders[0]}.`, ['n6'])).toBe('citation');
      expect(states(`The only ${other} shown is ${holders[0]}.`, ['n6', 'n7', 'n8'])).toBe('citation');
      expect(states(`Only ${others} are shown: ${holders[0]} and ${holders[1]}.`, ['n6', 'n7'])).toBe('citation');
    });

    it('keeps it over a set the sentence cites whole, and one that holds a single element', () => {
      expect(states(`Only ${others} are shown: ${holders[0]}, ${holders[1]} and ${holders[2]}.`, ['n6', 'n7', 'n8'])).toBe('kept');
      const single = build();
      const one: CheckedText = { ...single, elementTypes: new Map([...(single.elementTypes ?? [])].filter(([key]) => !['n7', 'n8'].includes(key))), lines: new Map([...single.lines].filter(([key]) => !['n7', 'n8'].includes(key))), keys: new Map([...single.keys].filter(([key]) => !['n7', 'n8'].includes(key))) };
      expect(verdict(`The only ${other} shown is ${holders[0]}.`, ['n6'], one)).toBe('kept');
    });

    it('keeps an `only` that a relation restricts: it says nothing of the whole type', () => {
      expect(states(`${a} was sent only to ${other} ${holders[0]}.`, ['n1', 'n6'])).toBe('kept');
      expect(states(`The only ${other} linked to ${a} is ${holders[0]}.`, ['n1', 'n6', 'e1'])).toBe('kept');
    });

    it('removes a definite `only` that a word of presence ends', () => {
      expect(states(`${holders[0]} is the only ${other} here.`, ['n6'])).toBe('citation');
    });

    it('keeps a sentence with `only` that is no quantifier of a set', () => {
      expect(states(`${a} was only seen once.`, ['n1'])).toBe('kept');
      expect(states(`${a} has the smallest ${amount} among ${a}, ${b} and ${c}, only ${b}.`, ['n1', 'n2', 'n3'])).not.toBe('kept');
    });
  });

  describe('a claim that nothing is given between the elements', () => {
    it.each(['given', 'provided', 'available', 'recorded', 'stated', 'included', 'found'])('is a claim of absence when it says `%s`, and needs the line of the server', (word) => {
      const text = `It also holds ${many}, and no relationships are ${word} between the elements.`;
      expect(verdict(text, ['n1', 'n2'])).toBe('citation');
      expect(verdict(text, ['n1', 'c1'])).toBe('kept');
    });

    it('is removed against a line that states a relationship, and kept against a line that states none', () => {
      const held = build();
      const withOne: CheckedText = { ...held, lines: new Map([...held.lines, ['c2', 'c2: view coverage: 8 entities shown · 1 relationship shown · ≥ 9 not yet retrieved (lower bound)']]), keys: new Map([...held.keys, ['c2', true]]), readKeys: new Set([...(held.readKeys ?? []), 'c2']) };
      expect(verdict('No relationships are given between the elements.', ['n1', 'c2'], withOne)).toBe('citation');
      expect(verdict('No relationships are given between the elements.', ['n1', 'c1'], withOne)).toBe('kept');
    });

    it('keeps a sentence that gives something, and one that says a property is not given as a value of an element while citing the line that backs it', () => {
      expect(verdict(`${a} has ${amount} 10.`, ['n1'])).toBe('kept');
      expect(verdict(`${a} has ${amount} 10 and no ${time} is given for it.`, ['n1'])).toBe('citation');
      expect(verdict(`${a} has ${amount} 10 and no ${time} is given for it.`, ['n1', 'c1'])).toBe('kept');
    });

    it('does not take a place word for the kind denied when the denial is of what it is of', () => {
      const held = build();
      const withOne: CheckedText = { ...held, lines: new Map([...held.lines, ['c2', 'c2: view coverage: 8 entities shown · 1 relationship shown · ≥ 9 not yet retrieved (lower bound)']]), keys: new Map([...held.keys, ['c2', true]]), readKeys: new Set([...(held.readKeys ?? []), 'c2']) };
      expect(verdict('None of the relationships are shown.', ['n1', 'c2', 'e1'], withOne)).toBe('citation');
      expect(verdict('Nothing is shown among the relationships.', ['n1', 'c2'], withOne)).toBe('citation');
    });
  });
});
