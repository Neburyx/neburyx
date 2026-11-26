import { describe, expect, it } from 'vitest';
import { removalNoteOf } from './removed-sentences.js';
import { judgeSentences, temporalKey, type CheckedText, type RankedProperty } from './reply-checks.js';

/** Two mappings' words: the rules are the same, every name comes from the mapping. */
const PACKS = [
  { name: 'transfers', item: 'transaction', holder: 'account', send: 'SENT', sender: 'sending', receive: 'RECEIVED_BY', receiver: 'receiving', peer: 'TRANSFERRED_TO', peerWord: 'transferred', status: 'paymentFormat', statusWords: 'payment format', flag: 'isShared', at: 'timestamp' },
  { name: 'filings', item: 'claim', holder: 'provider', send: 'FILED', sender: 'filing', receive: 'REPAIRED_BY', receiver: 'repairing', peer: 'REFERRED_TO', peerWord: 'referred', status: 'lossType', statusWords: 'loss type', flag: 'isShared', at: 'filedAt' },
] as const;

type Property = readonly [key: string, value: string | number | boolean | undefined, dataClass?: string, masked?: boolean];
interface Element {
  readonly key: string;
  readonly type: string;
  readonly title: string;
  readonly properties?: readonly Property[];
  /** The two ends of a relationship, as keys of entities. */
  readonly ends?: readonly [string, string];
}

function textOf(elements: readonly Element[], reads: Readonly<Record<string, { readonly line: string; readonly lists: readonly string[] }>> = {}): CheckedText {
  const valuesOf = (element: Element): string => (element.properties ?? []).flatMap(([key, value]) => (value === undefined ? [] : [` | ${key}: ${JSON.stringify(value)}`])).join('');
  const lines = new Map<string, string>(elements.map((element) => [element.key, `${element.key}: ${element.type}: ${element.title}${valuesOf(element)}`]));
  for (const [key, read] of Object.entries(reads)) lines.set(key, `${key}: ${read.line}`);
  const byKey = new Map(elements.map((element) => [element.key, element]));
  const identity = (key: string): readonly [string, string] => {
    const element = byKey.get(key);
    return [element?.type ?? '', element?.title ?? key];
  };
  const classOf = ([, value, dataClass]: Property): string => dataClass ?? (typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string');
  return {
    text: [...lines.values()].join('\n'),
    keys: new Map([...lines.keys()].map((key) => [key, true] as const)),
    lines,
    inexactCounts: [],
    unknownCountKeys: new Set(),
    elementTypes: new Map(elements.map((element) => [element.key, element.ends === undefined ? `entity ${element.type}` : `relationship ${element.type}`])),
    elementNames: new Map(elements.map((element) => [element.key, [element.title]])),
    elementEnds: new Map(elements.map((element) => [element.key, element.ends === undefined ? [identity(element.key)] : element.ends.map(identity)])),
    propertyKeys: new Map(elements.map((element) => [element.key, (element.properties ?? []).filter(([, value]) => value !== undefined).map(([key]) => key)])),
    rankedValues: new Map(
      elements.map((element) => [
        element.key,
        (element.properties ?? []).map((property): RankedProperty => {
          const [key, value, , masked] = property;
          const dataClass = classOf(property);
          const ordered = value === undefined || masked === true ? undefined : dataClass === 'number' ? String(value) : temporalKey(dataClass, String(value));
          return { key, dataClass, ...(ordered === undefined ? {} : { value: ordered }) };
        }),
      ]),
    ),
    elementValues: new Map(elements.map((element) => [element.key, (element.properties ?? []).flatMap(([key, value, , masked]) => (value === undefined ? [] : [{ key, text: String(value), masked: masked === true }]))])),
    readKeys: new Set(Object.keys(reads)),
    readElements: new Map(Object.entries(reads).map(([key, read]) => [key, read.lists])),
  };
}

const verdict = (held: CheckedText, text: string, cites: readonly string[]): string => {
  const judged = judgeSentences([{ text, cites: [...cites] }], held);
  return judged.kept.length === 1 ? 'kept' : (judged.rejected[0]?.reason ?? 'none');
};

describe.each(PACKS)('claims that elements differ, are the same or share something, in the words of the $name mapping', (pack) => {
  const { item, holder, status, statusWords, flag, at } = pack;
  const items = `${item}s`;
  const holders = `${holder}s`;
  const Holder = `${holder[0]?.toUpperCase() ?? ''}${holder.slice(1)}`;

  describe('about a property', () => {
    const element = (index: number, value: string | undefined, extra: readonly Property[] = [], masked = false): Element => ({
      key: `n${index}`,
      type: item,
      title: `Item ${'ABCD'[index - 1] ?? ''}`,
      properties: [[status, value, undefined, masked], ...extra],
    });
    const held = (...values: (string | undefined)[]): CheckedText => textOf(values.map((value, index) => element(index + 1, value)));
    const two = ['n1', 'n2'];
    const three = ['n1', 'n2', 'n3'];

    it('keeps the same value only when every subject holds it, and the one stated', () => {
      const same = held('Wire', 'Wire', 'Wire');
      expect(verdict(same, `These three have the same ${statusWords}.`, three)).toBe('kept');
      expect(verdict(same, `These three have the same ${statusWords}, Wire.`, three)).toBe('kept');
      expect(verdict(same, `The three share the ${statusWords} "Wire".`, three)).toBe('kept');
      expect(verdict(same, `These three have the same ${statusWords}, and they are listed.`, three)).toBe('kept');
      expect(verdict(same, `These three have the same ${statusWords}, Cash.`, three)).toBe('comparison');
      expect(verdict(held('Wire', 'Wire', 'Cash'), `These three have the same ${statusWords}.`, three)).toBe('comparison');
      expect(verdict(held('Wire', 'Wire', 'Cash'), `Item A and Item B have the same ${statusWords}.`, three)).toBe('kept');
      expect(verdict(held('Wire', 'Wire', 'Cash'), `Item A and Item C have the same ${statusWords}.`, three)).toBe('comparison');
    });

    it('takes a number of holders of a stated value: they are the subjects', () => {
      const mostly = held('Wire', 'Wire', 'Cash');
      expect(verdict(mostly, `The ${statusWords} Wire is shared by two of them.`, three)).toBe('kept');
      expect(verdict(mostly, `The ${statusWords} Wire is shared by several of them.`, three)).toBe('kept');
      expect(verdict(mostly, `The ${statusWords} Wire is shared by all three of them.`, three)).toBe('comparison');
      expect(verdict(mostly, `The ${statusWords} Cash is shared by several of them.`, three)).toBe('comparison');
      expect(verdict(mostly, `Item C and two others share the ${statusWords} Wire.`, three)).toBe('comparison');
    });

    it('reads different, differ, vary and each', () => {
      const mixed = held('Wire', 'Wire', 'Cash');
      const apart = held('Wire', 'Card', 'Cash');
      expect(verdict(apart, `These three have different ${statusWords}s.`, three)).toBe('kept');
      expect(verdict(mixed, `These three have different ${statusWords}s.`, three)).toBe('comparison');
      expect(verdict(mixed, `The ${statusWords}s vary.`, three)).toBe('kept');
      expect(verdict(mixed, `The ${statusWords}s differ.`, three)).toBe('comparison');
      expect(verdict(mixed, `Each of the ${statusWords}s varies.`, three)).toBe('comparison');
      expect(verdict(held('Wire', 'Wire'), `The ${statusWords}s vary.`, two)).toBe('comparison');
      expect(verdict(apart, `Their ${statusWords}s differ from one another.`, three)).toBe('kept');
      expect(verdict(apart, `The ${statusWords}s differ: Wire and Card.`, three)).toBe('kept');
    });

    it('reads the listed negations and removes any other', () => {
      const apart = held('Wire', 'Card', 'Cash');
      const mixed = held('Wire', 'Wire', 'Cash');
      expect(verdict(apart, `No two of these three share a ${statusWords}.`, three)).toBe('kept');
      expect(verdict(mixed, `No two of these three share a ${statusWords}.`, three)).toBe('comparison');
      expect(verdict(apart, `None of these three share a ${statusWords}.`, three)).toBe('kept');
      expect(verdict(apart, `Item A and Item B do not have the same ${statusWords}.`, two)).toBe('kept');
      expect(verdict(mixed, `Item A and Item B do not have the same ${statusWords}.`, two)).toBe('comparison');
      expect(verdict(mixed, `These three do not all have the same ${statusWords}.`, three)).toBe('kept');
      expect(verdict(held('Wire', 'Wire'), `These two do not all have the same ${statusWords}.`, two)).toBe('comparison');
      expect(verdict(apart, `These three do not differ in ${statusWords}.`, three)).toBe('comparison');
      expect(verdict(apart, `Never have these three had the same ${statusWords}.`, three)).toBe('comparison');
    });

    it('compares the day of the one moment property, at one offset', () => {
      const moments = (...values: string[]): CheckedText => textOf(values.map((value, index): Element => ({ key: `n${index + 1}`, type: item, title: `Item ${'ABC'[index] ?? ''}`, properties: [[at, value, 'dateTime']] })));
      expect(verdict(moments('2022-09-10T23:55:00Z', '2022-09-10T01:00:00Z'), 'Both fall on the same day.', two)).toBe('kept');
      expect(verdict(moments('2022-09-10T23:55:00Z', '2022-09-11T01:00:00Z'), 'Both fall on the same day.', two)).toBe('comparison');
      expect(verdict(moments('2022-09-10T23:55:00Z', '2022-09-10T01:00:00+05:00'), 'Both fall on the same date.', two)).toBe('comparison');
      expect(verdict(held('Wire', 'Wire'), 'Both fall on the same day.', two)).toBe('comparison');
    });

    it('reads the property after "in", and every value the sentence lists', () => {
      const apart = held('Wire', 'Card');
      for (const text of [`These two differ in ${statusWords}.`, `These two differ in their ${statusWords}.`, `The two vary in ${statusWords}.`]) expect(verdict(apart, text, two), text).toBe('kept');
      expect(verdict(held('Wire', 'Wire'), `These two are identical in ${statusWords}.`, two)).toBe('kept');
      expect(verdict(apart, `These two have different ${statusWords}s, Wire and Card.`, two)).toBe('kept');
      expect(verdict(apart, `These two have different ${statusWords}s, Wire and cash.`, two)).toBe('comparison');
    });

    it('holds a stated value of several words to a subject too', () => {
      const apart = held('Wire', 'cash machine');
      expect(verdict(apart, `These two have different ${statusWords}s, wire and cash machine.`, two)).toBe('kept');
      expect(verdict(apart, `These two have different ${statusWords}s, wire and point of sale.`, two)).toBe('comparison');
    });

    it('removes what it cannot test: a missing or masked value, one subject, a wrong number, an unnamed aspect', () => {
      expect(verdict(held('Wire', 'Wire', undefined), `These ${items} share the same ${statusWords}.`, three)).toBe('comparison');
      expect(verdict(textOf([element(1, 'W***'), element(2, 'W***', [], true)]), `Both have the same ${statusWords}.`, two)).toBe('comparison');
      expect(verdict(held('Wire'), `This one has the same ${statusWords}.`, ['n1'])).toBe('comparison');
      expect(verdict(held('Wire', 'Wire'), `These three have the same ${statusWords}.`, two)).toBe('comparison');
      expect(verdict(held('Wire', 'Wire'), 'Both share the same colour.', two)).toBe('comparison');
      expect(verdict(held('Wire', 'Wire'), 'Both are alike.', two)).toBe('comparison');
      const mixedTypes = textOf([element(1, 'Wire'), { key: 'n2', type: holder, title: 'Gamma', properties: [[status, 'Wire']] }]);
      expect(verdict(mixedTypes, `They have the same ${statusWords}.`, two)).toBe('comparison');
    });

    it('takes a property’s own name for its true or false value, and nothing else of that name', () => {
      const one = (value: boolean): CheckedText => textOf([{ key: 'n1', type: item, title: 'Item A', properties: [[flag, value]] }]);
      expect(verdict(one(false), 'Item A is not shared.', ['n1'])).toBe('kept');
      expect(verdict(one(true), 'Item A is not shared.', ['n1'])).toBe('comparison');
      expect(verdict(one(true), 'Item A is shared.', ['n1'])).toBe('kept');
      expect(verdict(one(false), 'Item A is shared.', ['n1'])).toBe('comparison');
      expect(verdict(held('Wire'), 'Item A is not shared.', ['n1'])).toBe('comparison');
    });
  });

  describe('about connected elements', () => {
    const entity = (key: string, type: string, title: string): Element => ({ key, type, title });
    const link = (key: string, type: string, from: string, to: string): Element => ({ key, type, ends: [from, to], title: `${type}: ${key}` });
    // Gamma sends three items; each is received by a holder of its own
    const elements: readonly Element[] = [
      entity('n1', item, 'Item A'), entity('n2', item, 'Item B'), entity('n3', item, 'Item C'),
      entity('h0', holder, 'Gamma'), entity('h1', holder, 'Delta'), entity('h2', holder, 'Epsilon'), entity('h3', holder, 'Zeta'),
      link('e1', pack.send, 'h0', 'n1'), link('e2', pack.send, 'h0', 'n2'), link('e3', pack.send, 'h0', 'n3'),
      link('e4', pack.receive, 'n1', 'h1'), link('e5', pack.receive, 'n2', 'h2'), link('e6', pack.receive, 'n3', 'h3'),
    ];
    const held = textOf(elements);
    const sends = ['e1', 'e2', 'e3', 'h0'];
    const receives = ['e4', 'e5', 'e6'];
    const all = [...sends, ...receives];

    it('keeps a shared or same connected element only when one is common to every subject', () => {
      expect(verdict(held, `Gamma sent Item A, Item B and Item C, so those three share that ${pack.sender} ${holder}.`, sends)).toBe('kept');
      expect(verdict(held, `These three have the same ${pack.sender} ${holder}, Gamma.`, sends)).toBe('kept');
      expect(verdict(held, `These three share a ${holder}.`, sends)).toBe('kept');
      expect(verdict(held, `These three share the same ${pack.receiver} ${holder}.`, all)).toBe('comparison');
      expect(verdict(held, `These three share the same ${holder}, Delta.`, [...sends, 'h1'])).toBe('comparison');
      expect(verdict(held, `Item A, Item B and Item C share that one counterparty, Gamma.`, sends)).toBe('kept');
      expect(verdict(held, `These three share one counterparty.`, sends)).toBe('comparison');
      expect(verdict(held, `These four share a ${holder}.`, sends)).toBe('comparison');
      expect(verdict(held, `These three share a ${holder}.`, ['e1', 'h0'])).toBe('comparison');
    });

    it('takes a role word only for the relationship type it is made from', () => {
      expect(verdict(held, `Gamma sent them, so these three share that ${pack.receiver === 'receiving' ? 'receiver' : 'repairer'}.`, sends)).toBe('comparison');
      expect(verdict(held, `These three share that funder, Gamma.`, sends)).toBe('comparison');
    });

    it('keeps a claim of different connected elements only with every link of the subjects cited and the sentence limited to what it has', () => {
      expect(verdict(held, `In view, these three have different ${pack.receiver} ${holders}.`, receives)).toBe('kept');
      expect(verdict(held, `These three have different ${pack.receiver} ${holders}.`, receives)).toBe('kept');
      expect(verdict(held, `The ${items} have different ${pack.receiver} ${holders}.`, receives)).toBe('comparison');
      expect(verdict(held, `These three have different ${pack.receiver} ${holders} in view.`, receives)).toBe('kept');
      expect(verdict(held, `None of these three share a ${pack.receiver} ${holder} in view.`, receives)).toBe('kept');
      expect(verdict(held, `None of these three share a ${pack.receiver} ${holder}.`, receives)).toBe('kept');
      expect(verdict(held, `None of the three ${items} share a ${pack.receiver} ${holder}.`, receives)).toBe('comparison');
      expect(verdict(held, `None of these three share a ${pack.receiver} ${holder} among those read.`, receives)).toBe('kept');
      expect(verdict(held, `These three have different ${pack.receiver} ${holders} among those read.`, receives)).toBe('kept');
      expect(verdict(held, `None of these three share a ${pack.sender} ${holder} in view.`, sends)).toBe('comparison');
      // one receiving link of a subject is not cited
      expect(verdict(textOf([...elements, link('e7', pack.receive, 'n1', 'h2')]), `None of these three share a ${pack.receiver} ${holder} in view.`, receives)).toBe('comparison');
      expect(verdict(textOf([...elements, link('e7', pack.receive, 'n1', 'h2')]), `None of these three share a ${pack.receiver} ${holder} in view.`, [...receives, 'e7'])).toBe('comparison');
    });

    it('removes a claim of difference or of one in common that rests on a read that is not exact, and takes pointing words only where no read listed the links', () => {
      const listedBy = (finding: string, unknown: readonly string[] = []): CheckedText => ({ ...textOf(elements, { s1: { line: `read of lookup: ${finding}`, lists: receives } }), unknownCountKeys: new Set(unknown) });
      const scoped = `None of these three share a ${pack.receiver} ${holder} among those read.`;
      const pointed = `None of these three share a ${pack.receiver} ${holder}.`;
      const cites = [...receives, 's1'];
      expect(verdict(listedBy('3 matches shown · exact'), scoped, cites)).toBe('kept');
      // the check is not told how a read was filtered: pointing at three is not enough once a read listed the links
      expect(verdict(listedBy('3 matches shown · exact'), pointed, cites)).toBe('comparison');
      expect(verdict(listedBy('3 matches shown · lower bound'), scoped, cites)).toBe('comparison');
      expect(verdict(listedBy('3 matches shown · not exact'), scoped, cites)).toBe('comparison');
      expect(verdict(listedBy('count not known · exact', ['s1']), scoped, cites)).toBe('comparison');
      // the read counts though the sentence does not cite it
      expect(verdict(listedBy('3 matches shown · lower bound'), scoped, receives)).toBe('comparison');
    });

    it('counts the connected elements themselves when they are what differs', () => {
      expect(verdict(held, `These three ${pack.receiver} ${holders} are different from each other.`, receives)).toBe('kept');
      expect(verdict(held, `These three ${pack.receiver} ${holders} are different.`, ['h1', 'h2', 'h3'])).toBe('kept');
      expect(verdict(held, `The ${pack.receiver} ${holders} differ.`, receives)).toBe('kept');
      expect(verdict(held, `Those went to Delta, Epsilon and Zeta, which are different ${holders}.`, [...receives, 'h1', 'h2', 'h3'])).toBe('kept');
      expect(verdict(held, `These four ${pack.receiver} ${holders} are different.`, receives)).toBe('comparison');
      expect(verdict(held, `The ${pack.sender} ${holders} differ.`, sends)).toBe('comparison');
    });

    it('takes the type of the subjects from the clause of the claim, not from a type another clause names', () => {
      expect(verdict(held, `These went to Delta, Epsilon and Zeta, which are different ${holders}, so none of them share a ${pack.receiver === 'receiving' ? 'receiver' : 'repairer'} among those read.`, [...receives, 'h1', 'h2', 'h3'])).toBe('kept');
    });

    it('takes every name that speaks of a subject as one, and removes a claim in which another stands in for it', () => {
      const shared = textOf([...elements.filter((each) => each.ends === undefined), link('e1', pack.send, 'h1', 'n1'), link('e2', pack.send, 'h3', 'n1'), link('e3', pack.send, 'h2', 'n2')]);
      // Zeta shares with Delta; Epsilon, which is named, does not, though Zeta could stand in for it
      expect(verdict(shared, `Delta and Epsilon share the same ${item}.`, ['h1', 'h3', 'n1', 'e1', 'e2'])).toBe('comparison');
      const peers = textOf([entity('a', holder, 'Alpha'), entity('b', holder, 'Beta'), entity('c', holder, 'Gamma'), link('e6', pack.peer, 'a', 'c'), link('e7', pack.peer, 'b', 'c')]);
      expect(verdict(peers, `Gamma and Beta ${pack.peerWord} to the same ${holder}.`, ['a', 'b', 'c', 'e6', 'e7'])).toBe('comparison');
      expect(verdict(peers, `Alpha and Beta ${pack.peerWord} to the same ${holder}.`, ['a', 'b', 'c', 'e6', 'e7'])).toBe('kept');
    });

    it('keeps a shared entity named with no type word, and tests it', () => {
      expect(verdict(held, 'Item A, Item B and Item C have Gamma in common.', [...sends, 'n1', 'n2', 'n3'])).toBe('kept');
      expect(verdict(held, 'Gamma is common to Item A, Item B and Item C.', [...sends, 'n1', 'n2', 'n3'])).toBe('kept');
      expect(verdict(held, 'Item A, Item B and Item C share Gamma.', [...sends, 'n1', 'n2', 'n3'])).toBe('kept');
      expect(verdict(held, 'Item A, Item B and Item C share Delta.', [...all, 'n1', 'n2', 'n3', 'h1'])).toBe('comparison');
    });

    it('takes the same or different connected entities in the plural as a claim of every one of every subject', () => {
      const lopsided = textOf([entity('a', holder, 'Alpha'), entity('b', holder, 'Beta'), entity('d', item, 'Item D'), entity('e', item, 'Item E'), link('e1', pack.send, 'a', 'd'), link('e2', pack.send, 'a', 'e'), link('e3', pack.send, 'b', 'e')]);
      const cites = ['a', 'b', 'd', 'e', 'e1', 'e2', 'e3'];
      for (const text of [`Alpha and Beta have the same ${items}.`, `Alpha and Beta have identical ${items}.`, `In view, the ${items} of Alpha and Beta are different.`, `In view, Alpha and Beta have ${items} that differ.`, `In view, the ${items} Alpha and Beta have are distinct.`]) expect(verdict(lopsided, text, cites), text).toBe('comparison');
    });

    it('reads a type whose name ends in an s as one entity, not several', () => {
      const place = `${holder}ss`;
      const both = textOf([entity('a', item, 'Item A'), entity('b', item, 'Item B'), entity('d', place, 'Delta'), entity('e', place, 'Epsilon'), link('e1', pack.send, 'a', 'd'), link('e2', pack.send, 'b', 'd'), link('e3', pack.send, 'a', 'e')]);
      expect(verdict(both, `Item A and Item B have the same ${place}, Delta.`, ['a', 'b', 'd', 'e1', 'e2'])).toBe('kept');
    });

    it('keeps a shared entity named before it is said to be shared, and tests it', () => {
      expect(verdict(held, 'Gamma is shared by Item A, Item B and Item C.', [...sends, 'n1', 'n2', 'n3'])).toBe('kept');
      expect(verdict(held, 'Delta is shared by Item A, Item B and Item C.', [...all, 'n1', 'n2', 'n3', 'h1'])).toBe('comparison');
    });

    it('does not take pointing words for a limit where the view states that not all of it was retrieved', () => {
      const partial = (line: string): CheckedText => textOf(elements, { c1: { line: `view coverage: ${line}`, lists: [] } });
      const text = `None of these three share a ${pack.receiver} ${holder}.`;
      expect(verdict(partial('7 entities shown · 0 not yet retrieved'), text, receives)).toBe('kept');
      expect(verdict(partial('7 entities shown · ≥ 40 not yet retrieved (lower bound)'), text, receives)).toBe('comparison');
      expect(verdict(partial('7 entities shown · ≥ 40 not yet retrieved (lower bound)'), `${text.slice(0, -1)} in view.`, receives)).toBe('kept');
    });

    it('keeps the only shared element when exactly one is joined to two or more subjects, over every link of them', () => {
      expect(verdict(held, `The only shared ${holder} in this sample is Gamma.`, all)).toBe('kept');
      expect(verdict(held, `The only shared ${holder} in this sample is Delta.`, [...all, 'h1'])).toBe('comparison');
      expect(verdict(held, `The only shared ${holder} is Gamma.`, all)).toBe('comparison');
      expect(verdict(held, `The only shared ${holder} among those read is Gamma.`, all)).toBe('kept');
      expect(verdict(held, `The only shared ${holder} in this sample is Gamma.`, sends)).toBe('comparison');
      const twoShared = textOf([...elements, link('e7', pack.receive, 'n1', 'h2')]);
      expect(verdict(twoShared, `The only shared ${holder} in this sample is Gamma.`, [...all, 'e7'])).toBe('comparison');
    });

    it('takes a relationship type whose two ends are one entity type, and relationships as the subject', () => {
      const peers = textOf([
        entity('a', holder, 'Alpha'), entity('b', holder, 'Beta'), entity('c', holder, 'Gamma'), entity('d', holder, 'Delta'),
        link('e1', pack.peer, 'a', 'c'), link('e2', pack.peer, 'b', 'c'), link('e3', pack.peer, 'a', 'b'), link('e4', pack.peer, 'a', 'd'),
      ]);
      expect(verdict(peers, `Alpha and Beta ${pack.peerWord} to the same ${holder}, Gamma.`, ['a', 'b', 'c', 'e1', 'e2'])).toBe('kept');
      expect(verdict(peers, `Alpha and Beta ${pack.peerWord} to the same ${holder}, Delta.`, ['a', 'b', 'd', 'e1', 'e2'])).toBe('comparison');
      expect(verdict(peers, `Alpha has three relationships, each to a different ${holder}.`, ['a', 'e1', 'e3', 'e4'])).toBe('kept');
      expect(verdict(peers, `Gamma and Beta are reached by two relationships, each to a different ${holder}.`, ['e1', 'e2'])).toBe('comparison');
    });

    it('compares the kind of link', () => {
      expect(verdict(held, 'These have the same kind of link.', ['e1', 'e2'])).toBe('kept');
      expect(verdict(held, 'These have the same kind of link.', ['e1', 'e4'])).toBe('comparison');
      expect(verdict(held, 'This has the same kind of link.', ['e1'])).toBe('comparison');
    });

    it('does not join elements through a derived relationship', () => {
      const derived = textOf([entity('a', holder, 'Alpha'), entity('b', holder, 'Beta'), link('e1', 'rule-7', 'a', 'b')]);
      expect(verdict(derived, `Alpha and Beta share an ${item}.`, ['a', 'b', 'e1'])).toBe('comparison');
    });
  });

  describe('sentences that use the words and claim nothing', () => {
    const held = textOf(
      [
        { key: 'n1', type: item, title: 'Item A', properties: [[status, 'Wire']] },
        { key: 'n2', type: item, title: 'Item B', properties: [[status, 'Cash']] },
        { key: 'h0', type: holder, title: 'Same Day Traders' },
      ],
      { s1: { line: `read of ${holders}-at-the-same-site: 0 matches shown · exact`, lists: [] }, c1: { line: 'view coverage: 3 entities shown · no relationship listed', lists: [] } },
    );

    it('judges as before a clause that says it cannot be told, and still tests the other clauses', () => {
      for (const text of [
        `The view does not show whether they share a ${holder}.`,
        `I cannot say whether any two share a ${holder}.`,
        `With no relationship shown, shared ${holders} cannot be seen.`,
        `No shared ${holder} is shown.`,
      ]) expect(verdict(held, text, ['c1']), text).toBe('kept');
      expect(verdict(held, `The view does not show their ${holders}, and these two have the same ${statusWords}.`, ['n1', 'n2', 'c1'])).toBe('comparison');
      expect(verdict(held, `These two do not share a ${holder}.`, ['n1', 'n2'])).toBe('comparison');
    });

    it('tests "the same" where the cited links reach a second entity of the type, though one alone is cited', () => {
      const linked = (second: string): CheckedText =>
        textOf([
          { key: 'a', type: item, title: 'Item A' }, { key: 'b', type: item, title: 'Item B' }, { key: 'd', type: holder, title: 'Delta' }, { key: 'e', type: holder, title: 'Epsilon' },
          { key: 'e1', type: pack.send, title: 'one', ends: ['a', 'd'] }, { key: 'e2', type: pack.send, title: 'two', ends: ['b', second] },
        ]);
      const text = `The same ${holder} is joined to Item A and Item B.`;
      const cites = ['a', 'b', 'd', 'e1', 'e2'];
      expect(verdict(linked('e'), text, cites)).toBe('comparison');
      expect(verdict(linked('d'), text, cites)).toBe('kept');
    });

    it('does not take a negated verb that another assertion carries for a clause that cannot tell', () => {
      expect(verdict(held, `These two share a ${holder} and its keeper is not known.`, ['n1', 'n2', 'c1'])).toBe('comparison');
      expect(verdict(held, `The view does not show their keepers and these two share a ${holder}.`, ['n1', 'n2', 'c1'])).toBe('comparison');
    });

    it('tests a claim that a later negated verb does not take as its subject', () => {
      expect(verdict(held, `These two have the same ${statusWords} whose keeper is not known.`, ['n1', 'n2', 'c1'])).toBe('comparison');
      expect(verdict(held, `These two have the same keeper not yet retrieved.`, ['n1', 'n2', 'c1'])).toBe('comparison');
      expect(verdict(held, 'Item A and Item B differ in a way not yet established.', ['n1', 'n2', 'c1'])).toBe('comparison');
      expect(verdict(held, `The view is coverage only, so shared ${holder}s cannot be seen.`, ['c1'])).toBe('kept');
      expect(verdict(held, `No shared ${holder} can be shown.`, ['c1'])).toBe('kept');
    });

    it('reads no claim in a name, a quoted text or a restated read, and removes any other claim that cites no element', () => {
      expect(verdict(held, 'Same Day Traders is listed.', ['h0'])).toBe('kept');
      expect(verdict(held, `The read of ${holders} at the same site returned 0 matches shown, exact.`, ['s1'])).toBe('kept');
      expect(verdict(held, 'The same read lists no relationship.', ['s1', 'c1'])).toBe('kept');
      expect(verdict(held, `These all share a ${holder}.`, ['s1'])).toBe('comparison');
    });

    it('takes "the same" that opens a sentence for the one cited element of a type, and tests it with two', () => {
      expect(verdict(held, `The same ${item} is listed.`, ['n1'])).toBe('kept');
      expect(verdict(held, `The same ${item} is listed.`, ['n1', 'n2'])).toBe('comparison');
      expect(verdict(held, `The same ${item} is listed with the same ${statusWords} as Item B.`, ['n1', 'n2'])).toBe('comparison');
    });
  });
});

describe('what the model is told of a removed comparison', () => {
  it('names a claim of difference, sameness or sharing and how to back it, with no value', () => {
    const note = removalNoteOf([{ text: 'They share it.', reason: 'comparison' }]);
    expect(note).toContain('differ, are the same or share something');
    expect(note).toContain('cite every element compared');
    expect(note).toContain('"in view" or "among those read"');
    expect(note).not.toMatch(/\d/u);
  });
});
