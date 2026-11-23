import { describe, expect, it } from 'vitest';
import { judgeSentences, type CheckedText } from './reply-checks.js';

/** The sentences of a hand test that were removed: a count of the entities a sentence names, cited through the relationship lines that end at them. */
interface Vocabulary {
  readonly name: string;
  readonly thing: string;
  readonly things: string;
  readonly owner: string;
  readonly link: string;
  readonly ids: readonly [string, string, string];
  readonly owners: readonly [string, string, string];
  readonly sentences: readonly [string, string, string, string];
}

const VOCABULARIES: readonly Vocabulary[] = [
  {
    name: 'transactions',
    thing: 'Transaction',
    things: 'transactions',
    owner: 'Account',
    link: 'SENT',
    ids: ['TX-004833841', 'TX-004833844', 'TX-004833978'],
    owners: ['350728:81297C3A0', '350852:812A296C0', '326563:8131C6E50'],
    sentences: ['Of these three transactions, none share a sending account.', 'The senders of three transactions were read: TX-004833841, TX-004833844 and TX-004833978.', 'Of the 3 transactions read, TX-004833841, TX-004833844 and TX-004833978, none share a sender.', 'No two of these three transactions have the same sender.'],
  },
  {
    name: 'claims',
    thing: 'Claim',
    things: 'claims',
    owner: 'Provider',
    link: 'FILED_BY',
    ids: ['CL-1001', 'CL-1002', 'CL-1003'],
    owners: ['PV-11', 'PV-12', 'PV-13'],
    sentences: ['Of these three claims, none share a filing provider.', 'The providers of three claims were read: CL-1001, CL-1002 and CL-1003.', 'Of the 3 claims read, CL-1001, CL-1002 and CL-1003, none share a provider.', 'No two of these three claims have the same provider.'],
  },
];

function held(vocabulary: Vocabulary, ends: readonly (readonly [string, string])[]): CheckedText {
  const lines = new Map<string, string>();
  const elementTypes = new Map<string, string>();
  const elementEnds = new Map<string, readonly (readonly [string, string])[]>();
  const elementNames = new Map<string, readonly string[]>();
  ends.forEach(([owner, id], index) => {
    const own = `r${index * 2 + 1}`;
    const link = `r${index * 2 + 2}`;
    lines.set(own, `${own}: ${vocabulary.owner.toLowerCase()}: ${vocabulary.owner} ${owner} | id: "${owner}"`);
    elementTypes.set(own, `entity ${vocabulary.owner.toLowerCase()}`);
    elementEnds.set(own, [[vocabulary.owner.toLowerCase(), owner]]);
    elementNames.set(own, [`${vocabulary.owner} ${owner}`, owner]);
    lines.set(link, `${link}: ${vocabulary.link}: ${vocabulary.owner} ${owner} → ${vocabulary.thing} ${id} | stored | members: 1 (exact)`);
    elementTypes.set(link, `relationship ${vocabulary.link}`);
    elementEnds.set(link, [[vocabulary.owner.toLowerCase(), owner], [vocabulary.thing.toLowerCase(), id]]);
    elementNames.set(link, [`${vocabulary.owner} ${owner} → ${vocabulary.thing} ${id}`, id]);
  });
  return { text: [...lines.values()].join('\n'), keys: new Map([...lines.keys()].map((key) => [key, true] as const)), lines, inexactCounts: [], unknownCountKeys: new Set(), elementTypes, elementEnds, elementNames };
}

describe.each(VOCABULARIES)('a count of the $name that the sentence cites through the lines of the relationships that end at them', (vocabulary) => {
  const pairs = vocabulary.ids.map((id, index) => [vocabulary.owners[index] ?? '', id] as const);
  const text = held(vocabulary, pairs);
  const links = ['r2', 'r4', 'r6'];
  const kept = (sentence: string, cites: string[], over: CheckedText = text): boolean => judgeSentences([{ text: sentence, cites }], over).kept.length === 1;

  it('keeps the exact sentences of the hand test, as a number word and as a digit', () => {
    for (const sentence of vocabulary.sentences) expect(judgeSentences([{ text: sentence, cites: links }], text).rejected.map((r) => r.reason), sentence).toEqual([]);
    expect(kept(`The senders of 3 ${vocabulary.things} were read.`, links)).toBe(true);
    // the lines of the owners cited beside them change nothing
    for (const sentence of vocabulary.sentences) expect(kept(sentence, ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']), sentence).toBe(true);
  });

  it('removes a count that is not the number of distinct entities of that type the cited relationships end at, in words and in digits', () => {
    for (const wrong of ['two', 'four', '2', '4']) expect(kept(`The senders of ${wrong} ${vocabulary.things} were read.`, links), wrong).toBe(false);
    // two relationships that end at one entity name one, not two or three
    const twice = held(vocabulary, [[vocabulary.owners[0], vocabulary.ids[0]], [vocabulary.owners[1], vocabulary.ids[0]], [vocabulary.owners[2], vocabulary.ids[0]]]);
    expect(kept(`The senders of three ${vocabulary.things} were read.`, links, twice)).toBe(false);
    expect(kept(`The sender of one ${vocabulary.thing.toLowerCase()} was read.`, links, twice)).toBe(true);
    // a cited relationship that is not cited is not counted
    expect(kept(`The senders of three ${vocabulary.things} were read.`, ['r2', 'r4'])).toBe(false);
    expect(kept(`The senders of two ${vocabulary.things} were read.`, ['r2', 'r4'])).toBe(true);
  });

  it('counts the entities of the other type the same way, and no type the relationships do not end at', () => {
    expect(kept(`The ${vocabulary.owner.toLowerCase()}s of three ${vocabulary.things} were read.`, links)).toBe(true);
    expect(kept(`Five ${vocabulary.things} were read.`, links)).toBe(false);
  });
});
